/**
 * 06-hub-contract — Provision tenant avec HMAC VALIDE (write side).
 *
 * Ce test crée vraiment un workspace côté bridge — on l'isole donc à STAGING
 * uniquement (pas en prod), avec préfixe `e2e-test-*` pour traçabilité.
 *
 * Secret HMAC lu via env HUB_HMAC_SECRET (mappé sur le secret staging dans
 * le workflow CI). Si le secret n'est pas fourni → test skip (utile pour le
 * mode "smoke uniquement").
 *
 * Idempotence : un retry avec le même tenant_id doit renvoyer la même
 * réponse (workspaceId stable).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { postSignedToBridge } from "../helpers/hub-hmac";
import {
  makeProvisionPayload,
  makeAttachOwnerPayload,
} from "../fixtures/test-data";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);
const SECRET = process.env.HUB_HMAC_SECRET;

test.describe(`Hub HMAC valid provision [${TARGET}]`, () => {
  test.skip(target.isDemo, "Demo n'expose pas le bridge HMAC publiquement");
  test.skip(
    TARGET === "prod",
    "Tests d'écriture HMAC interdits en prod (utilisé staging)",
  );
  test.skip(
    !SECRET || SECRET.length < 32,
    "HUB_HMAC_SECRET non fourni (≥ 32 chars requis)",
  );

  test("POST /api/tenants/provision avec HMAC valide → 200 + workspaceId stable", async () => {
    const payload = makeProvisionPayload();
    const res1 = await postSignedToBridge(
      target.bridgeUrl,
      "/api/tenants/provision",
      payload,
      SECRET!,
    );
    expect(res1.status, `provision 1st call → ${res1.status}`).toBeLessThan(
      400,
    );
    const body1 = (await res1.json()) as {
      workspace_id?: string;
      tenant_id?: string;
    };
    expect(body1).toHaveProperty("workspace_id");
    expect(body1.workspace_id).toBeTruthy();

    // Retry idempotent — même payload, même résultat
    const res2 = await postSignedToBridge(
      target.bridgeUrl,
      "/api/tenants/provision",
      payload,
      SECRET!,
    );
    expect(res2.status).toBeLessThan(400);
    const body2 = (await res2.json()) as { workspace_id?: string };
    expect(body2.workspace_id).toBe(body1.workspace_id);
  });

  test("POST /api/tenants/attach-owner avec HMAC valide → 200 idempotent", async () => {
    const provisionPayload = makeProvisionPayload();
    const provisionRes = await postSignedToBridge(
      target.bridgeUrl,
      "/api/tenants/provision",
      provisionPayload,
      SECRET!,
    );
    expect(provisionRes.status).toBeLessThan(400);

    // Attach même owner
    const attachPayload = makeAttachOwnerPayload({
      tenant_id: provisionPayload.tenant_id,
      user_email: provisionPayload.owner_email,
    });
    const attach1 = await postSignedToBridge(
      target.bridgeUrl,
      "/api/tenants/attach-owner",
      attachPayload,
      SECRET!,
    );
    expect(attach1.status, `attach-owner → ${attach1.status}`).toBeLessThan(400);

    // Retry idempotent
    const attach2 = await postSignedToBridge(
      target.bridgeUrl,
      "/api/tenants/attach-owner",
      attachPayload,
      SECRET!,
    );
    expect(attach2.status).toBeLessThan(400);
  });

  test("GET /api/tenants/:id/health avec HMAC valide → 200 + metrics", async () => {
    // Provision first
    const payload = makeProvisionPayload();
    const provRes = await postSignedToBridge(
      target.bridgeUrl,
      "/api/tenants/provision",
      payload,
      SECRET!,
    );
    expect(provRes.status).toBeLessThan(400);

    // GET health avec sig (body vide pour GET)
    const { signHubRequest } = await import("../helpers/hub-hmac");
    const headers = signHubRequest("", SECRET!);
    const healthRes = await fetch(
      `${target.bridgeUrl}/api/tenants/${payload.tenant_id}/health`,
      { method: "GET", headers },
    );
    expect(healthRes.status, `health → ${healthRes.status}`).toBeLessThan(400);
    const body = await healthRes.json();
    expect(body).toBeTruthy();
  });
});
