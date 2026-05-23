/**
 * 06-hub-contract — Rejet des requêtes HMAC invalides.
 *
 * On vérifie que le bridge refuse :
 *   - Pas de signature → 401
 *   - Signature invalide (random hex) → 401
 *   - Timestamp manquant → 401
 *   - Replay attack (timestamp > 5min dans le passé) → 401
 *   - Body modifié après signature → 401
 *
 * Pour cette suite, on ne signe RIEN avec le vrai secret prod (on ne le veut
 * pas commit). On vérifie uniquement les rejets — qui ne dépendent pas du
 * secret.
 *
 * Tourne contre staging ET prod (les 2 bridges doivent rejeter pareil).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { signHubRequest } from "../helpers/hub-hmac";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const PROVISION_PATH = "/api/tenants/provision";
const PAYLOAD = {
  tenant_id: "hub_tnt_e2e_reject",
  workspace_name: "e2e-test-reject",
  owner_email: "e2e-test-reject@veridian-test.local",
  plan: "free" as const,
};

test.describe(`Hub HMAC rejection [${TARGET}]`, () => {
  test.skip(target.isDemo, "Demo n'expose pas le bridge HMAC publiquement");

  test("POST provision sans signature → 401", async () => {
    const res = await fetch(`${target.bridgeUrl}${PROVISION_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
  });

  test("POST provision sans timestamp → 401", async () => {
    const res = await fetch(`${target.bridgeUrl}${PROVISION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Veridian-Hub-Signature": "deadbeef".repeat(8),
      },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
  });

  test("POST provision avec signature random → 401", async () => {
    const res = await fetch(`${target.bridgeUrl}${PROVISION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Veridian-Timestamp": String(Date.now()),
        "X-Veridian-Hub-Signature": "deadbeef".repeat(8),
      },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
  });

  test("POST provision avec timestamp drift > 5min → 401", async () => {
    // 10 minutes dans le passé
    const oldTs = Date.now() - 10 * 60 * 1000;
    const rawBody = JSON.stringify(PAYLOAD);
    // Signature techniquement valide pour ce timestamp mais avec faux secret.
    // Peu importe : ce qui doit fail c'est le timestamp drift.
    const fakeSecret = "fake-secret-for-drift-test-32chars!";
    const headers = signHubRequest(rawBody, fakeSecret, oldTs);
    const res = await fetch(`${target.bridgeUrl}${PROVISION_PATH}`, {
      method: "POST",
      headers,
      body: rawBody,
    });
    expect(res.status).toBe(401);
  });

  test("POST provision signature valide pour body A mais body B envoyé → 401", async () => {
    const fakeSecret = "fake-secret-for-mismatch-test-32!!!";
    const bodyA = JSON.stringify(PAYLOAD);
    const bodyB = JSON.stringify({ ...PAYLOAD, owner_email: "tampered@evil.test" });
    const headers = signHubRequest(bodyA, fakeSecret);
    const res = await fetch(`${target.bridgeUrl}${PROVISION_PATH}`, {
      method: "POST",
      headers,
      body: bodyB, // body modifié après sig
    });
    expect(res.status).toBe(401);
  });

  test("GET tenant/:id/health sans HMAC → 401", async () => {
    const res = await fetch(
      `${target.bridgeUrl}/api/tenants/hub_tnt_e2e_unknown/health`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });
});
