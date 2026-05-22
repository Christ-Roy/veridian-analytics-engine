/**
 * E2E 04 — GSC OAuth + sync flow (A4).
 *
 * Le ticket A4 ajoutera :
 *   - POST /api/admin/gsc/oauth-begin?tenantId=... → URL OAuth Google
 *   - GET  /api/admin/gsc/oauth-callback?code=... → stocke tokens chiffrés
 *   - POST /api/admin/gsc/sync?tenantId=... → fetch données + insert GscDaily
 *   - GET  /api/admin/tenant/:workspaceId/gsc?days=30 → data formatée
 *
 * STATUT 2026-05-22 : A4 EST mergé sur dev (`src/gsc/` +
 * `tests/integration/gsc-end-to-end.test.ts`). Mais les routes GSC sont
 * montées par `registerGscRoutes(app, {...})` dans `index.ts`, PAS dans
 * `createApp()`. Le fixture E2E (`bootBridgeForTest`) utilise `createApp`
 * seul → les routes `/api/admin/gsc/*` répondent 404 ici.
 *
 * Pour activer ces E2E : étendre `bridge-fixture.ts` pour appeler
 * `registerGscRoutes` (fake Prisma + fake OAuth config). Tant que ce câblage
 * fixture n'est pas fait, on garde `test.describe.skip()` — la couverture
 * intégration A4 (`tests/integration/gsc-end-to-end.test.ts`) reste la
 * source de vérité.
 */

import { test, expect } from "@playwright/test";
import {
  bootBridgeForTest,
  fakeHubTenantId,
  type BridgeFixture,
} from "../helpers/bridge-fixture.js";
import { VALID_PROVISION_PAYLOAD } from "../helpers/fixtures.js";

let bridge: BridgeFixture;
let workspaceId: string;
let tenantId: string;

test.beforeAll(async () => {
  bridge = await bootBridgeForTest();
  tenantId = fakeHubTenantId("gsc");
  const res = await bridge.signedFetch("POST", "/api/tenants/provision", {
    ...VALID_PROVISION_PAYLOAD,
    tenant_id: tenantId,
    workspace_name: "GSC Test",
  });
  const body = await res.json();
  workspaceId = body.workspace_id ?? "ws_fake_1";
});

test.afterAll(async () => {
  await bridge?.close();
});

// TODO: enable when A4 (gsc-integration-port) is merged on dev
test.describe.skip("GSC OAuth — flow complet", () => {
  test("POST /api/admin/gsc/oauth-begin → URL Google auth + state", async () => {
    const res = await bridge.adminFetch(
      "POST",
      `/api/admin/gsc/oauth-begin?tenantId=${tenantId}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toMatch(/accounts\.google\.com.*oauth2.*scope=/);
    expect(body.state).toBeTruthy();
  });

  test("GET /api/admin/gsc/oauth-callback (mock) → tokens stockés", async () => {
    // En vrai E2E avec mock OAuth server, on captgure le state du begin
    // et on POST sur le callback avec un code factice.
    // Tant que A4 n'est pas mergé, on ne peut pas tester le callback réel.
    const res = await fetch(
      `${bridge.url}/api/admin/gsc/oauth-callback?code=fake-code&state=fake-state`
    );
    expect([200, 302, 400]).toContain(res.status);
  });

  test("POST /api/admin/gsc/sync → GscDaily rows insérées", async () => {
    const res = await bridge.adminFetch(
      "POST",
      `/api/admin/gsc/sync?tenantId=${tenantId}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("rows");
    expect(typeof body.rows).toBe("number");
  });

  test("GET /api/admin/tenant/:workspaceId/gsc?days=30 → data formatée", async () => {
    const res = await bridge.adminFetch(
      "GET",
      `/api/admin/tenant/${workspaceId}/gsc?days=30`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("clicks");
    expect(body).toHaveProperty("impressions");
    expect(body).toHaveProperty("ctr");
    expect(body).toHaveProperty("position");
    expect(body).toHaveProperty("timeseries");
    expect(Array.isArray(body.timeseries)).toBe(true);
  });
});

// Test toujours actif : si l'endpoint /api/admin/gsc/* existe pas encore,
// il doit renvoyer 404 (et pas crasher).
test.describe("GSC endpoints — pré-A4 (404 expected)", () => {
  test("POST /api/admin/gsc/oauth-begin sans Bearer → 401", async () => {
    const res = await fetch(
      `${bridge.url}/api/admin/gsc/oauth-begin?tenantId=${tenantId}`,
      { method: "POST" }
    );
    expect([401, 404]).toContain(res.status);
  });
});
