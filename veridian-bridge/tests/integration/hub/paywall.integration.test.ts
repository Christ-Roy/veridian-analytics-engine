/**
 * ════════════════════════════════════════════════════════════════════════════
 * paywall.integration.test.ts — requireActivePlan() contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T2. Couvre `src/paywall.ts` adossé à `PrismaTenantStore`.
 *
 * Le test unitaire `tests/hub/paywall-required.test.ts` exerce `requireActivePlan`
 * contre un `InMemoryTenantStore` : il prouve juste la logique de mapping
 * status→reason. Ici on branche `requireActivePlan` sur le VRAI store Postgres
 * (`h.store`), avec des rows Tenant dont le `status` est posé directement en DB.
 *
 * Ce que ça prouve :
 *   - Un tenant `status='suspended'` LU depuis Postgres → `requireActivePlan`
 *     lève bien `PaywallError(402)`.
 *   - Les 3 statuts non-actifs (`suspended`, `trial_expired`, `soft_deleted`)
 *     déclenchent chacun le bon code paywall.
 *   - Un tenant `active` passe et renvoie le record relu de Postgres.
 *   - Une mutation de status EN DB est immédiatement reflétée par un nouveau
 *     `requireActivePlan` (pas de cache mémoire qui mentirait).
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  seedTenant,
  type BridgeHarness,
} from "../_harness/index.js";
import { requireActivePlan, PaywallError, isPlanActive } from "../../../src/paywall.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDb(h.prisma);
});

// ─── tenant active → passe ──────────────────────────────────────────────────

test("paywall — tenant active en DB → requireActivePlan renvoie le record", async () => {
  const t = await seedTenant(h.prisma, {
    hubTenantId: "hub_pw_active",
    status: "active",
  });

  const record = await requireActivePlan(t.id, h.store);
  assert.equal(record.status, "active");
  assert.equal(record.id, t.id, "le record vient bien de Postgres (même id)");
  assert.equal(record.hubTenantId, "hub_pw_active");
});

// ─── 3 statuts non-actifs → 402 ─────────────────────────────────────────────

test("paywall — tenant suspended en DB → PaywallError(402, paywall_suspended)", async () => {
  const t = await seedTenant(h.prisma, {
    hubTenantId: "hub_pw_susp",
    status: "suspended",
  });

  await assert.rejects(
    () => requireActivePlan(t.id, h.store),
    (err: unknown) => {
      assert.ok(err instanceof PaywallError, "doit être un PaywallError");
      assert.equal(err.status, 402);
      assert.equal(err.code, "paywall_suspended");
      assert.equal(err.tenantId, t.id);
      return true;
    },
  );
});

test("paywall — tenant trial_expired en DB → PaywallError(402, paywall_trial_expired)", async () => {
  const t = await seedTenant(h.prisma, {
    hubTenantId: "hub_pw_trial",
    status: "trial_expired",
  });

  await assert.rejects(
    () => requireActivePlan(t.id, h.store),
    (err: unknown) => {
      assert.ok(err instanceof PaywallError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "paywall_trial_expired");
      return true;
    },
  );
});

test("paywall — tenant soft_deleted en DB → PaywallError(402, paywall_soft_deleted)", async () => {
  const t = await seedTenant(h.prisma, {
    hubTenantId: "hub_pw_soft",
    status: "soft_deleted",
  });

  await assert.rejects(
    () => requireActivePlan(t.id, h.store),
    (err: unknown) => {
      assert.ok(err instanceof PaywallError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "paywall_soft_deleted");
      return true;
    },
  );
});

// ─── tenant inexistant → Error générique (pas un PaywallError) ──────────────

test("paywall — tenant inexistant → Error tenant_not_found (pas un PaywallError)", async () => {
  await assert.rejects(
    () => requireActivePlan("tnt_does_not_exist", h.store),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        !(err instanceof PaywallError),
        "absence de tenant n'est pas du paywall — c'est de la résolution (404)",
      );
      assert.match((err as Error).message, /tenant_not_found/);
      return true;
    },
  );
});

// ─── une mutation de status EN DB est immédiatement vue ─────────────────────

test("paywall — UPDATE status en Postgres → requireActivePlan reflète le changement", async () => {
  const t = await seedTenant(h.prisma, {
    hubTenantId: "hub_pw_mutate",
    status: "active",
  });

  // Au départ : actif → passe.
  await assert.doesNotReject(() => requireActivePlan(t.id, h.store));

  // On suspend RÉELLEMENT en DB (UPDATE Postgres).
  await h.prisma.tenant.update({
    where: { id: t.id },
    data: { status: "suspended", suspendedAt: new Date() },
  });

  // Le store relit Postgres : aucun cache mémoire → 402 immédiat.
  await assert.rejects(
    () => requireActivePlan(t.id, h.store),
    (err: unknown) => err instanceof PaywallError && err.code === "paywall_suspended",
  );

  // On réactive : repasse.
  await h.prisma.tenant.update({
    where: { id: t.id },
    data: { status: "active", suspendedAt: null },
  });
  const reactivated = await requireActivePlan(t.id, h.store);
  assert.equal(reactivated.status, "active");
});

// ─── isPlanActive helper sur record réel ────────────────────────────────────

test("paywall — isPlanActive() sur des records relus de Postgres", async () => {
  const active = await seedTenant(h.prisma, {
    hubTenantId: "hub_pw_h_active",
    status: "active",
  });
  const suspended = await seedTenant(h.prisma, {
    hubTenantId: "hub_pw_h_susp",
    status: "suspended",
  });

  const activeRecord = await h.store.findById(active.id);
  const suspendedRecord = await h.store.findById(suspended.id);
  assert.ok(activeRecord && suspendedRecord);
  assert.equal(isPlanActive(activeRecord), true);
  assert.equal(isPlanActive(suspendedRecord), false);
});
