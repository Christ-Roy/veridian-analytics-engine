/**
 * Test 4/11 — body modifié après signature → 401.
 *
 * Scénario : un attaquant intercepte une requête signée valide, garde les
 * headers, mais modifie le body. Le serveur doit recompute le HMAC sur le
 * body reçu et invalider.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHubBridge, signedFetch, type HubBridgeFixture } from "./helpers.js";

let bridge: HubBridgeFixture;

beforeEach(async () => {
  bridge = await createHubBridge();
});

afterEach(async () => {
  await bridge.close();
});

test("body modifié après signature → 401 invalid_signature", async () => {
  // On signe sur un body et on envoie un body différent
  const tamperedBody = JSON.stringify({
    tenant_id: "tnt-evil",
    owner_email: "evil@attacker.com",
    workspace_name: "Pwned",
    plan: "enterprise",
  });
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    {
      tenant_id: "tnt-ok",
      owner_email: "alice@ok.com",
      workspace_name: "Original",
      plan: "free",
    },
    { bodyAfterSign: tamperedBody }
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "invalid_signature");
});

test("body avec espace supplémentaire → 401 (HMAC sensible aux octets)", async () => {
  const tampered = JSON.stringify({
    tenant_id: "tnt-x",
    owner_email: "x@x.com",
    workspace_name: "X",
    plan: "free",
  }) + " "; // ← espace en plus
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    {
      tenant_id: "tnt-x",
      owner_email: "x@x.com",
      workspace_name: "X",
      plan: "free",
    },
    { bodyAfterSign: tampered }
  );
  assert.equal(res.status, 401);
});

test("tenant pas créé quand body modifié", async () => {
  const tamperedBody = JSON.stringify({
    tenant_id: "tnt-never-created",
    owner_email: "evil@x.com",
    workspace_name: "Bad",
    plan: "free",
  });
  await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    {
      tenant_id: "tnt-ok",
      owner_email: "alice@ok.com",
      workspace_name: "Original",
      plan: "free",
    },
    { bodyAfterSign: tamperedBody }
  );
  assert.equal(bridge.store._all().length, 0, "aucun tenant ne doit avoir été créé");
});
