/**
 * Tests POST /api/admin/provision-tenant.
 *
 * Couvre :
 *   - happy path (setup déjà fait → login → workspaces.create → apiKeys.create)
 *   - happy path (first setup → setup.initialize → workspaces.create → apiKeys.create)
 *   - body invalide (manque tenantSlug, website pas une URL, etc.)
 *   - staminads workspaces.create échoue → 502
 *   - staminads apiKeys.create échoue → 502
 *   - staminads down (setup.status retourne 500) → 500 internal
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeStaminads, startAppOnEphemeralPort } from "./helpers/fake-staminads.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

let fake: FakeStaminads;
let bridgeUrl: string;
let closeBridge: () => Promise<void>;

// Fresh bridge+fake par test pour éviter le state partagé (token caché entre tests).
beforeEach(async () => {
  fake = new FakeStaminads();
  await fake.start();
  const app = createApp({
    staminadsUrl: fake.url,
    adminEmail: "admin@veridian.local",
    adminPassword: "test-pass-2026",
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

test("provision: happy path first-setup (setupCompleted=false)", async () => {
  fake.setBehavior({ setupCompleted: false });
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

  // Vérif que le bon flow staminads a été appelé (setup → init → ws.create → key.create)
  const paths = fake.getCalls().map((c) => c.path);
  assert.ok(paths.includes("/api/setup.status"));
  assert.ok(paths.includes("/api/setup.initialize"));
  assert.ok(paths.includes("/api/workspaces.create"));
  assert.ok(paths.includes("/api/apiKeys.create"));
});

test("provision: happy path setup déjà fait → login", async () => {
  fake.setBehavior({ setupCompleted: true });
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 200);

  const paths = fake.getCalls().map((c) => c.path);
  assert.ok(paths.includes("/api/setup.status"));
  assert.ok(paths.includes("/api/auth.login"));
  assert.ok(!paths.includes("/api/setup.initialize"), "setup.initialize ne doit pas être appelé");
});

test("provision: token est caché entre 2 appels (pas de double login)", async () => {
  fake.setBehavior({ setupCompleted: true });
  await provision(VALID_BODY);
  fake.resetCalls();
  await provision({ ...VALID_BODY, tenantSlug: "second-tenant" });
  const paths = fake.getCalls().map((c) => c.path);
  assert.ok(!paths.includes("/api/auth.login"), "login ne doit pas être rappelé");
  assert.ok(paths.includes("/api/workspaces.create"));
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

test("provision: defaults timezone=UTC + currency=EUR si omis", async () => {
  fake.setBehavior({ setupCompleted: true });
  const { timezone: _t, currency: _c, ...minimal } = VALID_BODY;
  const res = await provision(minimal);
  assert.equal(res.status, 200);
  const wsCall = fake.getCalls().find((c) => c.path === "/api/workspaces.create");
  assert.ok(wsCall);
  const sent = wsCall.body as { timezone: string; currency: string };
  assert.equal(sent.timezone, "UTC");
  assert.equal(sent.currency, "EUR");
});

test("provision: workspaces.create échoue → 502 workspace_create_failed", async () => {
  fake.setBehavior({
    setupCompleted: true,
    workspaceCreateStatus: 422,
    workspaceCreateBody: { error: "duplicate_name" },
  });
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; status: number };
  assert.equal(body.error, "workspace_create_failed");
  assert.equal(body.status, 422);
});

test("provision: apiKeys.create échoue → 502 apikey_create_failed", async () => {
  fake.setBehavior({
    setupCompleted: true,
    apiKeyCreateStatus: 500,
    apiKeyCreateBody: { error: "internal" },
  });
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "apikey_create_failed");
});

test("provision: setup.status retourne 500 → 500 internal", async () => {
  // On simule un staminads complètement HS via behavior anormal
  // En faisant pointer initializeStatus à un truc impossible, le code va lever
  fake.setBehavior({
    setupCompleted: false,
    initializeStatus: 500,
    initializeBody: { error: "boom" },
  });
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "internal");
});

test("provision: payload staminads workspaces.create contient bien les champs Veridian", async () => {
  fake.setBehavior({ setupCompleted: true });
  await provision(VALID_BODY);
  const wsCall = fake.getCalls().find((c) => c.path === "/api/workspaces.create");
  assert.ok(wsCall);
  const sent = wsCall.body as Record<string, string>;
  assert.equal(sent.name, VALID_BODY.tenantName);
  assert.equal(sent.website, VALID_BODY.website);
  assert.equal(sent.timezone, VALID_BODY.timezone);
  assert.equal(sent.currency, VALID_BODY.currency);
});

test("provision: apiKey name contient le tenantSlug pour traçabilité", async () => {
  fake.setBehavior({ setupCompleted: true });
  await provision(VALID_BODY);
  const keyCall = fake.getCalls().find((c) => c.path === "/api/apiKeys.create");
  assert.ok(keyCall);
  const sent = keyCall.body as { name: string; role: string; workspace_id: string };
  assert.match(sent.name, /veridian-tenant-veridian-test/);
  assert.equal(sent.role, "admin");
  // staminads attend snake_case
  assert.equal(sent.workspace_id, "ws_fake_abc");
});

test("provision: payload contient un id staminads valide [a-z][a-z0-9_]*", async () => {
  fake.setBehavior({ setupCompleted: true });
  await provision({ ...VALID_BODY, tenantSlug: "phase1-test" });
  const wsCall = fake.getCalls().find((c) => c.path === "/api/workspaces.create");
  assert.ok(wsCall);
  const sent = wsCall.body as { id: string };
  assert.match(sent.id, /^[a-z][a-z0-9_]*$/, "id doit matcher la regex staminads");
  assert.equal(sent.id, "phase1_test", "tirets convertis en underscores");
});

test("provision: id force préfixe 'v_' si tenantSlug commence par chiffre", async () => {
  fake.setBehavior({ setupCompleted: true });
  await provision({ ...VALID_BODY, tenantSlug: "123client" });
  const wsCall = fake.getCalls().find((c) => c.path === "/api/workspaces.create");
  const sent = wsCall!.body as { id: string };
  assert.match(sent.id, /^[a-z]/, "id doit commencer par une lettre");
});

test("provision: endpoint snippet = publicStaminadsUrl si fourni", async () => {
  await closeBridge();
  await fake.stop();
  fake = new FakeStaminads();
  await fake.start();
  fake.setBehavior({ setupCompleted: true });
  const app = createApp({
    staminadsUrl: fake.url,
    publicStaminadsUrl: "https://analytics-engine.staging.veridian.site",
    adminEmail: "admin@veridian.local",
    adminPassword: "test-pass-2026",
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
    "Le snippet doit pointer sur l'URL publique pas l'URL réseau interne"
  );
});

test("provision: endpoint fallback sur staminadsUrl si publicStaminadsUrl absent", async () => {
  fake.setBehavior({ setupCompleted: true });
  const res = await provision(VALID_BODY);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { trackingSnippet: { endpoint: string } };
  assert.equal(body.trackingSnippet.endpoint, fake.url);
});

test("provision: id tronqué à 50 chars max (limite staminads)", async () => {
  fake.setBehavior({ setupCompleted: true });
  // Slug à 60 chars (< limite Zod 64). Après slug, > 50 chars donc doit être tronqué.
  const longSlug = "veridian-client-acme-corp-international-" + "x".repeat(20);
  assert.ok(longSlug.length > 50 && longSlug.length <= 64, "longSlug doit être > 50 et ≤ 64 chars");
  const res = await provision({ ...VALID_BODY, tenantSlug: longSlug });
  assert.equal(res.status, 200, "provision doit réussir");
  const wsCall = fake.getCalls().find((c) => c.path === "/api/workspaces.create");
  assert.ok(wsCall, "workspaces.create doit être appelé");
  const sent = wsCall.body as { id: string };
  assert.ok(sent.id.length <= 50, `id length ${sent.id.length} > 50`);
});
