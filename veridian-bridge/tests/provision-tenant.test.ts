/**
 * Tests POST /api/admin/provision-tenant (endpoint POC interne).
 *
 * Depuis la migration M2M (2026-06-16) : un SEUL appel natif
 * `POST /api/admin/platform/tenants.provision` (Bearer PLATFORM_ADMIN_API_KEY),
 * plus de flow setup.status / auth.login / workspaces.create / apiKeys.create.
 *
 * Couvre :
 *   - happy path (1 call tenants.provision → workspace + apiKey)
 *   - body invalide (manque tenantSlug, website pas une URL, etc.)
 *   - Engine provision échoue (502) → 502 provision_failed
 *   - email owner dérivé bot+<slug>@veridian.site
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeStaminads, startAppOnEphemeralPort } from "./helpers/fake-staminads.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";
const PLATFORM_KEY = "veridian-test-platform-key-32-chars!!";

let fake: FakeStaminads;
let bridgeUrl: string;
let closeBridge: () => Promise<void>;

// Fresh bridge+fake par test pour éviter le state partagé.
beforeEach(async () => {
  fake = new FakeStaminads();
  await fake.start();
  const app = createApp({
    staminadsUrl: fake.url,
    platformAdminApiKey: PLATFORM_KEY,
    veridianAdminApiKey: ADMIN_KEY,
  });
  const started = await startAppOnEphemeralPort(app);
  bridgeUrl = started.url;
  closeBridge = started.close;
});

afterEach(async () => {
  await closeBridge();
  await fake.stop();
});

const VALID_BODY = {
  tenantSlug: "veridian-test",
  tenantName: "Veridian Test",
  website: "https://demo.veridian.site",
  timezone: "Europe/Paris",
  currency: "EUR",
};

async function provision(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${bridgeUrl}/api/admin/provision-tenant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_KEY}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("provision: happy path → 1 call M2M tenants.provision", async () => {
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    tenantSlug: string;
    staminadsWorkspaceId: string;
    staminadsApiKey: string;
    trackingSnippet: { workspaceId: string; endpoint: string };
  };
  assert.equal(body.tenantSlug, "veridian-test");
  assert.equal(body.staminadsWorkspaceId, "ws_fake_abc");
  assert.equal(body.staminadsApiKey, "sk_live_fake_apikey_for_tests");
  assert.equal(body.trackingSnippet.workspaceId, "ws_fake_abc");
  assert.equal(body.trackingSnippet.endpoint, fake.url);

  // Un SEUL appel natif M2M, plus de cascade setup/login/create.
  const paths = fake.getCalls().map((c) => c.path);
  assert.deepEqual(paths, ["/api/admin/platform/tenants.provision"]);
});

test("provision: appelle le natif avec Bearer PLATFORM_ADMIN_API_KEY", async () => {
  await provision(VALID_BODY);
  const call = fake
    .getCalls()
    .find((c) => c.path === "/api/admin/platform/tenants.provision");
  assert.ok(call);
  assert.equal(call.headers["authorization"], `Bearer ${PLATFORM_KEY}`);
});

test("provision: email owner dérivé bot+<slug>@veridian.site", async () => {
  await provision(VALID_BODY);
  const call = fake
    .getCalls()
    .find((c) => c.path === "/api/admin/platform/tenants.provision");
  const sent = call!.body as { email: string; name: string; siteUrl: string };
  assert.equal(sent.email, "bot+veridian-test@veridian.site");
  assert.equal(sent.name, VALID_BODY.tenantName);
  assert.equal(sent.siteUrl, VALID_BODY.website);
});

test("provision: body manque tenantSlug → 400 invalid_body", async () => {
  const { tenantSlug: _omit, ...partial } = VALID_BODY;
  const res = await provision(partial);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_body");
});

test("provision: website pas une URL → 400 invalid_body", async () => {
  const res = await provision({ ...VALID_BODY, website: "not-a-url" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_body");
});

test("provision: tenantSlug vide → 400", async () => {
  const res = await provision({ ...VALID_BODY, tenantSlug: "" });
  assert.equal(res.status, 400);
});

test("provision: tenantName trop long (>120) → 400", async () => {
  const res = await provision({ ...VALID_BODY, tenantName: "x".repeat(121) });
  assert.equal(res.status, 400);
});

test("provision: Engine renvoie 500 → 502 provision_failed", async () => {
  fake.setBehavior({
    provisionStatus: 500,
    provisionBody: { error: "provisioning_failed" },
  });
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; status: number };
  assert.equal(body.error, "provision_failed");
  assert.equal(body.status, 500);
});

test("provision: Engine renvoie 409 (email exists) → 502 provision_failed", async () => {
  fake.setBehavior({
    provisionStatus: 409,
    provisionBody: { error: "email_already_exists" },
  });
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; status: number };
  assert.equal(body.error, "provision_failed");
  assert.equal(body.status, 409);
});

test("provision: endpoint snippet = publicStaminadsUrl si fourni", async () => {
  await closeBridge();
  await fake.stop();
  fake = new FakeStaminads();
  await fake.start();
  const app = createApp({
    staminadsUrl: fake.url,
    publicStaminadsUrl: "https://analytics-engine.staging.veridian.site",
    platformAdminApiKey: PLATFORM_KEY,
    veridianAdminApiKey: ADMIN_KEY,
  });
  const started = await startAppOnEphemeralPort(app);
  bridgeUrl = started.url;
  closeBridge = started.close;

  const res = await provision(VALID_BODY);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { trackingSnippet: { endpoint: string } };
  assert.equal(
    body.trackingSnippet.endpoint,
    "https://analytics-engine.staging.veridian.site",
    "Le snippet doit pointer sur l'URL publique pas l'URL réseau interne",
  );
});

test("provision: endpoint fallback sur staminadsUrl si publicStaminadsUrl absent", async () => {
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { trackingSnippet: { endpoint: string } };
  assert.equal(body.trackingSnippet.endpoint, fake.url);
});
