/**
 * ════════════════════════════════════════════════════════════════════════════
 * cascade.integration.test.ts — cascade FK Tenant → Push* contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le schéma Prisma déclare `onDelete: Cascade` sur :
 *   - PushSubscription.tenant
 *   - PushNotification.tenant
 *
 * Une cascade FK est un comportement de Postgres : elle n'existe PAS dans le
 * `FakePrismaClient`. Supprimer un Tenant DOIT emporter ses PushSubscription
 * et ses PushNotification — sinon on aurait des rows orphelines pointant un
 * tenantId mort (corruption référentielle).
 *
 * Ce fichier prouve la cascade en supprimant un vrai Tenant et en comptant
 * les rows restantes directement en Postgres.
 *
 * Isolation cross-fichier : pas de `resetDb()` (TRUNCATE global). Les tenants
 * sont seedés via `seedTenantUnique` (cf `_seed.ts`, colonnes `@unique`
 * randomisées contre la collision cross-process) et toutes les assertions de
 * comptage sont SCOPÉES au(x) tenant(s) du test (`where: { tenantId }`) — un
 * `count()` global serait pollué par les autres fichiers parallèles.
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  type BridgeHarness,
} from "../_harness/index.js";
import { seedTenantUnique } from "./_seed.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

const KEYS = { p256dh: "BPp256dh-cascade", auth: "auth-cascade" };

async function seedPushData(
  tenantId: string,
  subs: number,
  notifs: number,
): Promise<void> {
  for (let i = 0; i < subs; i++) {
    await h.prisma.pushSubscription.create({
      data: {
        tenantId,
        endpoint: `https://fcm.googleapis.com/fcm/send/casc-${i}-${randomUUID()}`,
        keys: KEYS,
      },
    });
  }
  for (let i = 0; i < notifs; i++) {
    await h.prisma.pushNotification.create({
      data: {
        tenantId,
        title: `notif ${i}`,
        body: "corps",
        targetCount: subs,
      },
    });
  }
}

// ─── 1. Supprimer un Tenant supprime ses PushSubscription + PushNotification ─

test("cascade: DELETE Tenant → PushSubscription et PushNotification cascadés", async () => {
  const tenant = await seedTenantUnique(h.prisma, "cascade-solo");
  await seedPushData(tenant.id, 3, 2);

  assert.equal(
    await h.prisma.pushSubscription.count({ where: { tenantId: tenant.id } }),
    3,
  );
  assert.equal(
    await h.prisma.pushNotification.count({ where: { tenantId: tenant.id } }),
    2,
  );

  // DELETE du Tenant → la FK `onDelete: Cascade` emporte tout.
  await h.prisma.tenant.delete({ where: { id: tenant.id } });

  assert.equal(
    await h.prisma.pushSubscription.count({ where: { tenantId: tenant.id } }),
    0,
    "les PushSubscription du tenant doivent cascader",
  );
  assert.equal(
    await h.prisma.pushNotification.count({ where: { tenantId: tenant.id } }),
    0,
    "les PushNotification du tenant doivent cascader",
  );
  assert.equal(
    await h.prisma.tenant.findUnique({ where: { id: tenant.id } }),
    null,
  );
});

// ─── 2. La cascade n'emporte QUE les rows du tenant supprimé ─────────────────

test("cascade: supprimer un tenant n'affecte pas les Push* d'un autre tenant", async () => {
  const tenantA = await seedTenantUnique(h.prisma, "cascade-A");
  const tenantB = await seedTenantUnique(h.prisma, "cascade-B");

  await seedPushData(tenantA.id, 2, 1);
  await seedPushData(tenantB.id, 4, 3);

  // On supprime UNIQUEMENT le tenant A.
  await h.prisma.tenant.delete({ where: { id: tenantA.id } });

  // Les rows de B doivent rester intactes.
  assert.equal(
    await h.prisma.pushSubscription.count({ where: { tenantId: tenantB.id } }),
    4,
    "les subs du tenant B survivent à la suppression du tenant A",
  );
  assert.equal(
    await h.prisma.pushNotification.count({ where: { tenantId: tenantB.id } }),
    3,
    "les notifs du tenant B survivent à la suppression du tenant A",
  );
  // Plus aucune row de A.
  assert.equal(
    await h.prisma.pushSubscription.count({ where: { tenantId: tenantA.id } }),
    0,
  );
  assert.equal(
    await h.prisma.pushNotification.count({ where: { tenantId: tenantA.id } }),
    0,
  );
});

// ─── 3. Aucune row orpheline après cascade ──────────────────────────────────

test("cascade: après suppression, aucune Push* du tenant ne subsiste", async () => {
  const tenant = await seedTenantUnique(h.prisma, "cascade-orph");
  await seedPushData(tenant.id, 5, 2);

  await h.prisma.tenant.delete({ where: { id: tenant.id } });

  // Après cascade, plus aucune Push* ne doit pointer ce tenantId mort.
  const remainingSubs = await h.prisma.pushSubscription.findMany({
    where: { tenantId: tenant.id },
  });
  assert.equal(remainingSubs.length, 0, "zéro PushSubscription orpheline");
  const remainingNotifs = await h.prisma.pushNotification.findMany({
    where: { tenantId: tenant.id },
  });
  assert.equal(remainingNotifs.length, 0, "zéro PushNotification orpheline");
});
