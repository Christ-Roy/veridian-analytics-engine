/**
 * E2E 03 — Forms submission flow (golden path B1).
 *
 * Le ticket B1 ajoutera :
 *   - POST /api/ingest/form (public — siteKey identifie le tenant)
 *   - Création FormSubmission en Postgres bridge
 *   - Dédup Lead par email
 *   - Push event `form_submission` côté staminads
 *   - GET /api/admin/tenant/:workspaceId/forms (Bearer) liste les submissions
 *
 * STATUT 2026-05-22 : B1 EST mergé sur dev (`src/forms/` + `tests/forms/*`
 * couvrent l'ingestion en unité avec un FakePrismaClient). Mais ces routes
 * sont montées par `registerFormsRoutes(app, { prisma })` dans `index.ts`,
 * PAS dans `createApp()`. Le fixture E2E (`bootBridgeForTest`) utilise
 * `createApp` seul → `/api/ingest/form` répond 404 ici.
 *
 * Pour activer ces E2E : étendre `bridge-fixture.ts` pour appeler
 * `registerFormsRoutes` avec un FakePrisma (cf. tests/helpers/fake-prisma-forms.ts).
 * Tant que ce câblage fixture n'est pas fait, on garde `test.describe.skip()` —
 * la couverture unité B1 (`tests/forms/*`) reste la source de vérité.
 */

import { test, expect } from "@playwright/test";
import {
  bootBridgeForTest,
  fakeHubTenantId,
  type BridgeFixture,
} from "../helpers/bridge-fixture.js";
import {
  VALID_PROVISION_PAYLOAD,
  VALID_FORM_SUBMISSION_PAYLOAD,
} from "../helpers/fixtures.js";

let bridge: BridgeFixture;
let workspaceId: string;
let siteKey: string;

test.beforeAll(async () => {
  bridge = await bootBridgeForTest();
  const tenantId = fakeHubTenantId("forms");
  const res = await bridge.signedFetch("POST", "/api/tenants/provision", {
    ...VALID_PROVISION_PAYLOAD,
    tenant_id: tenantId,
    workspace_name: "Forms Test",
  });
  if (res.status === 201 || res.status === 200) {
    const body = await res.json();
    workspaceId = body.workspace_id ?? "ws_fake_1";
    siteKey = body.site_key || VALID_FORM_SUBMISSION_PAYLOAD.siteKey;
  }
});

test.afterAll(async () => {
  await bridge?.close();
});

// TODO: enable when B1 (forms ingestion) is merged on dev
test.describe.skip("Forms submission — golden path", () => {
  test("POST /api/ingest/form (public) → 201 + FormSubmission créé", async () => {
    const res = await fetch(`${bridge.url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...VALID_FORM_SUBMISSION_PAYLOAD,
        siteKey,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("submissionId");
    expect(body).toHaveProperty("leadId");
  });

  test("GET /api/admin/tenant/:workspaceId/forms → liste submissions", async () => {
    const res = await bridge.adminFetch(
      "GET",
      `/api/admin/tenant/${workspaceId}/forms`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.submissions)).toBe(true);
    expect(body.submissions.length).toBeGreaterThan(0);
    expect(body.submissions[0]).toHaveProperty("fields");
    expect(body.submissions[0]).toHaveProperty("submittedAt");
  });

  test("Dédup Lead par email — 2 submissions même email → 1 seul Lead", async () => {
    const payload = { ...VALID_FORM_SUBMISSION_PAYLOAD, siteKey };
    await fetch(`${bridge.url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await fetch(`${bridge.url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await bridge.adminFetch(
      "GET",
      `/api/admin/tenant/${workspaceId}/leads`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const matchingLeads = body.leads.filter(
      (l: { email: string }) => l.email === VALID_FORM_SUBMISSION_PAYLOAD.fields.email
    );
    expect(matchingLeads).toHaveLength(1);
  });

  test("Rate limit /api/ingest/form (11e req/min) → 429", async () => {
    const payload = { ...VALID_FORM_SUBMISSION_PAYLOAD, siteKey };
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${bridge.url}/api/ingest/form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      results.push(res.status);
    }
    // Au moins une 429 dans les 12 req
    expect(results).toContain(429);
  });

  test("POST /api/ingest/form siteKey inexistant → 404", async () => {
    const res = await fetch(`${bridge.url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...VALID_FORM_SUBMISSION_PAYLOAD,
        siteKey: "does-not-exist",
      }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/ingest/form payload malformé → 400 + zod error", async () => {
    const res = await fetch(`${bridge.url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteKey, fields: "not-an-object" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
