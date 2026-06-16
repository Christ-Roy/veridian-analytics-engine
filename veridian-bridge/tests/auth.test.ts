/**
 * Tests middleware requireVeridianAdmin sur les routes protégées.
 * On vérifie 401/403 indépendamment de l'endpoint réel.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeStaminads, startAppOnEphemeralPort } from "./helpers/fake-staminads.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

let fake: FakeStaminads;
let bridgeUrl: string;
let closeBridge: () => Promise<void>;

beforeEach(async () => {
  fake = new FakeStaminads();
  await fake.start();
  const app = createApp({
    staminadsUrl: fake.url,
      platformAdminApiKey: "veridian-test-platform-key-32-chars!!",
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

const PROTECTED_ROUTES = [
  { method: "POST", path: "/api/admin/provision-tenant", body: {} },
  { method: "POST", path: "/api/admin/track-test", body: {} },
  { method: "GET", path: "/api/admin/analytics?wsId=x", body: undefined },
];

for (const route of PROTECTED_ROUTES) {
  test(`${route.method} ${route.path}: sans Authorization → 401 missing_bearer`, async () => {
    const res = await fetch(`${bridgeUrl}${route.path}`, {
      method: route.method,
      headers: { "Content-Type": "application/json" },
      body: route.body !== undefined ? JSON.stringify(route.body) : undefined,
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "missing_bearer");
  });

  test(`${route.method} ${route.path}: avec mauvaise clé → 403 invalid_admin_key`, async () => {
    const res = await fetch(`${bridgeUrl}${route.path}`, {
      method: route.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: route.body !== undefined ? JSON.stringify(route.body) : undefined,
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_admin_key");
  });

  test(`${route.method} ${route.path}: header Authorization sans "Bearer " → 401`, async () => {
    const res = await fetch(`${bridgeUrl}${route.path}`, {
      method: route.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: ADMIN_KEY, // pas de prefix Bearer
      },
      body: route.body !== undefined ? JSON.stringify(route.body) : undefined,
    });
    assert.equal(res.status, 401);
  });
}

test("auth: les requêtes auth ne touchent pas staminads", async () => {
  await fetch(`${bridgeUrl}/api/admin/provision-tenant`, { method: "POST" });
  await fetch(`${bridgeUrl}/api/admin/provision-tenant`, {
    method: "POST",
    headers: { Authorization: "Bearer bad" },
  });
  // Aucun appel sortant vers staminads ne doit avoir eu lieu
  assert.equal(fake.getCalls().length, 0, "staminads ne doit pas être appelé sur 401/403");
});
