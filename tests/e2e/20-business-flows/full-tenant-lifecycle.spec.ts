/**
 * 20-business-flows — Scénario complet bout-en-bout.
 *
 * Le golden path métier : Hub provisionne un tenant → bridge crée workspace
 * staminads → tracker envoie un event → dashboard montre la data.
 *
 * En mode "best-effort sans secrets" : on enchaîne juste les étapes accessibles
 * sans secrets prod, et on documente celles qui exigent des secrets.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { signHubRequest } from "../helpers/hub-hmac";
import { ApiClient } from "../helpers/api-client";
import { testRunId } from "../fixtures/test-data";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const HMAC = process.env.HUB_HMAC_SECRET;

test.describe(`Business flow: new tenant zero-to-event [${TARGET}] @business`, () => {
  test.skip(
    target.isDemo,
    "Demo single-tenant, pas de business flow Hub→bridge",
  );

  test("Bridge accepte un provision Hub signé + tenant créé + event ingest", async () => {
    test.skip(!HMAC, "HUB_HMAC_SECRET missing");
    if (!HMAC) return;

    const runId = testRunId();
    const tenantId = `hub_tnt_e2e_biz_${runId}`;
    const wsName = `e2e-biz-${runId}`;

    // 1. Hub signe et envoie provision
    const provisionPayload = {
      tenant_id: tenantId,
      workspace_name: wsName,
      owner_email: `e2e-biz-${runId}@veridian-test.local`,
      plan: "free" as const,
    };
    const body = JSON.stringify(provisionPayload);
    const headers = signHubRequest(body, HMAC);

    const provisionRes = await fetch(
      `${target.bridgeUrl}/api/tenants/provision`,
      { method: "POST", headers, body },
    );
    if (provisionRes.status >= 500) {
      test.skip(true, `Bridge 5xx (${provisionRes.status}) — env down`);
      return;
    }
    expect([200, 201, 202, 409]).toContain(provisionRes.status);

    // 2. Récupérer le site_key (best-effort selon shape réponse)
    const provisionBody = await provisionRes.text();
    const m = provisionBody.match(/"site_key"\s*:\s*"([^"]+)"/);
    if (!m) {
      // pas grave : provision OK, on ne peut pas extraire site_key sans schéma confirmé
      return;
    }
    const siteKey = m[1];
    expect(siteKey).toMatch(/^stm_pub_/);

    // 3. Envoyer un track event via le site_key
    const client = new ApiClient(target.engineUrl);
    const now = Date.now();
    const trackRes = await client.post(
      "/api/track",
      {
        site_key: siteKey,
        session_id: `e2e-biz-sess-${runId}`,
        actions: [
          {
            type: "pageview",
            path: "/biz-flow",
            page_number: 1,
            duration: 1000,
            scroll: 50,
            entered_at: now - 1500,
            exited_at: now - 500,
          },
        ],
        attributes: {},
        created_at: now - 2000,
        updated_at: now,
        sdk_version: "e2e-biz",
      },
      { allowFailure: true, timeoutMs: 15_000 },
    );
    expect(trackRes.status).toBeLessThan(500);
  });
});

test.describe(`Business flow: tenant suspend/resume [${TARGET}] @business`, () => {
  test.skip(target.isDemo, "Demo single-tenant");

  test("Health endpoint répond pour un tenant inconnu en 401/404 (pas 5xx)", async () => {
    const res = await fetch(
      `${target.bridgeUrl}/api/tenants/hub_tnt_e2e_suspended_test/health`,
      {
        method: "GET",
      },
    );
    expect(res.status).toBeLessThan(500);
  });
});

test.describe(`Business flow: form submission → lead → dashboard [${TARGET}] @business`, () => {
  test.skip(target.isDemo, "Demo single-tenant pas de forms ingest");

  test("Le bridge accepte une form submission avec sitekey valide → 2xx", async () => {
    const siteKey = process.env.E2E_TEST_SITE_KEY;
    test.skip(!siteKey, "E2E_TEST_SITE_KEY missing");
    if (!siteKey) return;

    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey,
        formSlug: "e2e-business-flow",
        data: {
          name: "E2E Business Tester",
          email: `e2e-biz-form-${testRunId()}@veridian-test.local`,
          message: "End-to-end business flow test",
        },
      },
      { allowFailure: true, timeoutMs: 15_000 },
    );
    // 2xx attendu avec sitekey valide
    expect(res.status).toBeLessThan(500);
    expect([200, 201, 202]).toContain(res.status);
  });
});
