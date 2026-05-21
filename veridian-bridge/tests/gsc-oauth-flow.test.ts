/**
 * Tests OAuth flow GSC :
 *   - encrypt/decrypt round-trip
 *   - state HMAC build/parse + tamper detection
 *   - oauthBeginFlow URL generation
 *   - exchangeCode avec mock Google → tokens persistés chiffrés
 *   - refreshAccessToken avec mock Google
 *   - error paths : invalid state, no refresh_token, token exchange 4xx
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptTokens,
  decryptTokens,
  buildState,
  parseState,
  oauthBeginFlow,
  exchangeCode,
  refreshAccessToken,
  persistTokensForTenant,
  getAccessTokenForProperty,
  oauthCallback,
  OauthFlowError,
  type OauthConfig,
  type OauthTokens,
} from "../src/gsc/index.js";
import { FakePrismaClient } from "./helpers/fake-prisma.js";

const KEY_HEX = "a".repeat(64);
const CFG: OauthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://bridge.test/api/admin/gsc/oauth-callback",
  encryptionKey: KEY_HEX,
};

test("encryptTokens / decryptTokens round-trip", () => {
  const tokens: OauthTokens = {
    access_token: "ya29.test-access-token",
    refresh_token: "1//test-refresh-token",
    expires_at: 1700000000000,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    token_type: "Bearer",
  };
  const blob = encryptTokens(tokens, KEY_HEX);
  assert.equal(blob.v, 1);
  assert.match(blob.iv, /^[0-9a-f]{24}$/);
  assert.match(blob.tag, /^[0-9a-f]{32}$/);
  assert.ok(blob.ciphertext.length > 0);
  assert.notEqual(blob.ciphertext, JSON.stringify(tokens));

  const decoded = decryptTokens(blob, KEY_HEX);
  assert.deepEqual(decoded, tokens);
});

test("decryptTokens fails with wrong key", () => {
  const tokens: OauthTokens = {
    access_token: "a", refresh_token: "b", expires_at: 0,
    scope: "s", token_type: "Bearer",
  };
  const blob = encryptTokens(tokens, KEY_HEX);
  const wrongKey = "b".repeat(64);
  assert.throws(() => decryptTokens(blob, wrongKey));
});

test("encryptTokens rejects invalid key length", () => {
  const tokens: OauthTokens = {
    access_token: "a", refresh_token: "b", expires_at: 0,
    scope: "s", token_type: "Bearer",
  };
  assert.throws(() => encryptTokens(tokens, "deadbeef"));
});

test("buildState / parseState round-trip", () => {
  const state = buildState("tenant_abc123", KEY_HEX);
  const back = parseState(state, KEY_HEX);
  assert.equal(back, "tenant_abc123");
});

test("parseState detects tampering", () => {
  const state = buildState("tenant_abc", KEY_HEX);
  const idx = state.lastIndexOf(".");
  const tampered = "tenant_evil" + state.slice(idx);
  assert.throws(() => parseState(tampered, KEY_HEX), OauthFlowError);
});

test("parseState rejects malformed state", () => {
  assert.throws(() => parseState("no-dot", KEY_HEX), OauthFlowError);
});

test("oauthBeginFlow generates Google auth URL with required params", () => {
  const { url, state } = oauthBeginFlow("tenant_xyz", CFG);
  assert.ok(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  const u = new URL(url);
  assert.equal(u.searchParams.get("client_id"), CFG.clientId);
  assert.equal(u.searchParams.get("redirect_uri"), CFG.redirectUri);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(
    u.searchParams.get("scope"),
    "https://www.googleapis.com/auth/webmasters.readonly",
  );
  assert.equal(u.searchParams.get("state"), state);
  assert.equal(parseState(state, KEY_HEX), "tenant_xyz");
});

function mockFetch(
  expected: { url?: string; body?: Record<string, string> },
  response: { status: number; body: unknown },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (expected.url) assert.ok(url.startsWith(expected.url), `URL mismatch: ${url}`);
    if (expected.body && init?.body) {
      const params = new URLSearchParams(init.body as string);
      for (const [k, v] of Object.entries(expected.body)) {
        assert.equal(params.get(k), v, `param ${k} mismatch`);
      }
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () =>
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body),
    } as unknown as Response;
  }) as typeof fetch;
}

test("exchangeCode succeeds and normalizes tokens", async () => {
  const fetchImpl = mockFetch(
    { url: "https://oauth2.googleapis.com/token", body: { code: "abc", grant_type: "authorization_code" } },
    {
      status: 200,
      body: {
        access_token: "ya29.fake",
        refresh_token: "1//fake-refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
        token_type: "Bearer",
      },
    },
  );
  const t = await exchangeCode("abc", CFG, fetchImpl);
  assert.equal(t.access_token, "ya29.fake");
  assert.equal(t.refresh_token, "1//fake-refresh");
  assert.ok(t.expires_at > Date.now());
  assert.equal(t.token_type, "Bearer");
});

test("exchangeCode rejects when Google returns no refresh_token", async () => {
  const fetchImpl = mockFetch(
    {},
    { status: 200, body: { access_token: "x", expires_in: 3600, scope: "s", token_type: "Bearer" } },
  );
  await assert.rejects(() => exchangeCode("abc", CFG, fetchImpl), OauthFlowError);
});

test("exchangeCode propagates 4xx", async () => {
  const fetchImpl = mockFetch(
    {},
    { status: 400, body: { error: "invalid_grant" } },
  );
  await assert.rejects(() => exchangeCode("abc", CFG, fetchImpl), (err: unknown) => {
    assert.ok(err instanceof OauthFlowError);
    assert.equal((err as OauthFlowError).status, 400);
    return true;
  });
});

test("refreshAccessToken returns new access_token", async () => {
  const fetchImpl = mockFetch(
    { body: { grant_type: "refresh_token", refresh_token: "rt_abc" } },
    { status: 200, body: { access_token: "ya29.new", expires_in: 1800 } },
  );
  const r = await refreshAccessToken("rt_abc", CFG, fetchImpl);
  assert.equal(r.access_token, "ya29.new");
  assert.ok(r.expires_at > Date.now());
});

test("persistTokensForTenant stores encrypted blob in GscProperty placeholder", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "tenant_1", workspaceId: "ws_1", slug: "t1", name: "T1" },
  });
  const tokens: OauthTokens = {
    access_token: "AT",
    refresh_token: "RT",
    expires_at: Date.now() + 3600_000,
    scope: "s",
    token_type: "Bearer",
  };
  await persistTokensForTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_1",
    tokens,
    KEY_HEX,
  );
  const props = await prisma.gscProperty.findMany({ where: { tenantId: "tenant_1" } });
  assert.equal(props.length, 1);
  const blob = (props[0] as { oauthAccount: unknown }).oauthAccount as {
    v: number;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  assert.equal(blob.v, 1);
  const decoded = decryptTokens(blob, KEY_HEX);
  assert.equal(decoded.access_token, "AT");
  assert.equal(decoded.refresh_token, "RT");
});

test("getAccessTokenForProperty refreshes when expired", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "tenant_1", workspaceId: "ws_1", slug: "t1", name: "T1" },
  });
  const expired: OauthTokens = {
    access_token: "OLD",
    refresh_token: "RT_VALID",
    expires_at: Date.now() - 300_000,
    scope: "s",
    token_type: "Bearer",
  };
  const blob = encryptTokens(expired, KEY_HEX);
  const prop = await prisma.gscProperty.create({
    data: {
      tenantId: "tenant_1",
      siteUrl: "https://example.com/",
      type: "SITE",
      ownershipState: "verified",
      oauthAccount: blob,
    },
  });
  const fetchImpl = mockFetch(
    { body: { refresh_token: "RT_VALID" } },
    { status: 200, body: { access_token: "NEW", expires_in: 3600 } },
  );
  const at = await getAccessTokenForProperty(
    prisma as unknown as import("@prisma/client").PrismaClient,
    prop.id,
    CFG,
    fetchImpl,
  );
  assert.equal(at, "NEW");
  const updated = await prisma.gscProperty.findUnique({ where: { id: prop.id } });
  const newTokens = decryptTokens(
    updated!.oauthAccount as unknown as Parameters<typeof decryptTokens>[0],
    KEY_HEX,
  );
  assert.equal(newTokens.access_token, "NEW");
  assert.equal(newTokens.refresh_token, "RT_VALID");
});

test("getAccessTokenForProperty returns cached when still valid", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "tenant_1", workspaceId: "ws_1", slug: "t1", name: "T1" },
  });
  const fresh: OauthTokens = {
    access_token: "FRESH",
    refresh_token: "RT",
    expires_at: Date.now() + 3600_000,
    scope: "s",
    token_type: "Bearer",
  };
  const blob = encryptTokens(fresh, KEY_HEX);
  const prop = await prisma.gscProperty.create({
    data: {
      tenantId: "tenant_1",
      siteUrl: "https://example.com/",
      type: "SITE",
      ownershipState: "verified",
      oauthAccount: blob,
    },
  });
  let fetchCalled = false;
  const fetchImpl = (async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  }) as typeof fetch;
  const at = await getAccessTokenForProperty(
    prisma as unknown as import("@prisma/client").PrismaClient,
    prop.id,
    CFG,
    fetchImpl,
  );
  assert.equal(at, "FRESH");
  assert.equal(fetchCalled, false);
});

test("oauthCallback validates state, exchanges code, persists tokens", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "tenant_999", workspaceId: "ws_999", slug: "t999", name: "T999" },
  });
  const state = buildState("tenant_999", KEY_HEX);
  const fetchImpl = mockFetch(
    {},
    {
      status: 200,
      body: {
        access_token: "AT_OK",
        refresh_token: "RT_OK",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
        token_type: "Bearer",
      },
    },
  );
  const result = await oauthCallback(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "code_xyz",
    state,
    CFG,
    fetchImpl,
  );
  assert.equal(result.tenantId, "tenant_999");
  const props = await prisma.gscProperty.findMany({ where: { tenantId: "tenant_999" } });
  assert.equal(props.length, 1);
});

test("oauthCallback rejects bad state", async () => {
  const prisma = new FakePrismaClient();
  await assert.rejects(
    () =>
      oauthCallback(
        prisma as unknown as import("@prisma/client").PrismaClient,
        "code",
        "bad-state-no-sig",
        CFG,
        mockFetch({}, { status: 200, body: {} }),
      ),
    OauthFlowError,
  );
});
