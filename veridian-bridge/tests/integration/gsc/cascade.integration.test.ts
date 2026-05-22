/**
 * ════════════════════════════════════════════════════════════════════════════
 * cascade.integration.test.ts — cascades FK GSC contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T4. Couvre les contraintes de `prisma/schema.prisma` côté GSC :
 *
 *   GscProperty.tenantId → Tenant       onDelete: Cascade
 *   GscDaily.gscPropertyId → GscProperty onDelete: Cascade
 *
 * Ce que ça PROUVE (impossible avec FakePrisma) :
 *
 *   - Supprimer un Tenant emporte ses GscProperty ET, en chaîne, toutes les
 *     GscDaily de ces properties. C'est la cascade SQL réelle qui parle —
 *     `prisma migrate deploy` a posé `ON DELETE CASCADE` sur les FK.
 *   - Supprimer une GscProperty emporte ses GscDaily mais laisse le Tenant.
 *   - La cascade n'est PAS globale : supprimer un Tenant ne touche pas les
 *     données GSC d'un AUTRE tenant.
 *   - Contraintes `@@unique` GSC : (tenantId, siteUrl) sur GscProperty.
 *
 * Si une migration future cassait une de ces FK (ex : passer en `onDelete:
 * Restrict`), ce fichier deviendrait rouge avant la prod.
 *
 * ─── Isolation ──────────────────────────────────────────────────────────────
 *
 * Le runner intégration `scripts/run-integration.mjs` (T3) exécute chaque
 * fichier dans son propre process + sa propre base jetable. Ce fichier va
 * néanmoins plus loin : il n'utilise PAS `resetDb()` du tout. Chaque test
 * seede son propre Tenant (id unique via `mkTenant`) et n'assert QUE sur des
 * entités scopées (`where` sur `tenantId` / `gscPropertyId`). Résultat : ces
 * tests restent corrects même si l'isolation du runner saute un jour.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  seedTenant,
  type BridgeHarness,
} from "../_harness/index.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

// Pas de `beforeEach(resetDb)` : on n'efface PAS la DB partagée (un autre
// fichier d'intégration peut tourner en parallèle). Chaque test seede ses
// propres entités et n'assert que sur elles.

// ─── Helpers de comptage SCOPÉ (jamais de count global) ─────────────────────

/** Nombre de GscProperty rattachées à un tenant précis. */
function countPropsOfTenant(tenantId: string): Promise<number> {
  return h.prisma.gscProperty.count({ where: { tenantId } });
}

/** Nombre de GscDaily rattachées (via property) à un tenant précis. */
function countDailyOfTenant(tenantId: string): Promise<number> {
  return h.prisma.gscDaily.count({
    where: { gscProperty: { tenantId } },
  });
}

/** Nombre de GscDaily d'une property précise. */
function countDailyOfProp(gscPropertyId: string): Promise<number> {
  return h.prisma.gscDaily.count({ where: { gscPropertyId } });
}

/**
 * Seed un Tenant avec des identifiants uniques CROSS-PROCESS.
 *
 * `seedTenant` du harness génère des `workspaceId`/`slug` du type `ws_seed_N`
 * via un compteur RESET à chaque process. Or `node --test` lance un process
 * par fichier, tous sur le MÊME Postgres → deux fichiers génèrent `ws_seed_1`
 * et collisionnent (P2002). On force donc un préfixe unique par process
 * (`RUN_NONCE`) sur tous les champs `@unique`.
 */
const RUN_NONCE = randomUUID().slice(0, 8);
let localSeed = 0;
function mkTenant(slugHint = "t") {
  localSeed += 1;
  const tag = `${RUN_NONCE}-${localSeed}`;
  return seedTenant(h.prisma, {
    workspaceId: `ws_${tag}`,
    slug: `${slugHint}-${tag}`,
    hubTenantId: `hub_${tag}`,
    apiKey: `sk_${tag}`,
  });
}


/**
 * Seed un Tenant + une GscProperty + `nDaily` rows GscDaily.
 * Retourne les ids pour les assertions scopées.
 */
async function seedGscTree(opts: { nDaily: number; siteUrl?: string }) {
  const tenant = await mkTenant();
  const prop = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: opts.siteUrl ?? `https://${tenant.slug}.example/`,
      type: "SITE",
      ownershipState: "verified",
      lastSyncAt: new Date(),
    },
  });
  for (let i = 0; i < opts.nDaily; i++) {
    await h.prisma.gscDaily.create({
      data: {
        gscPropertyId: prop.id,
        date: new Date(`2026-05-${String(10 + i).padStart(2, "0")}T00:00:00Z`),
        query: `kw_${i}`,
        page: `/p${i}`,
        country: "fra",
        device: "DESKTOP",
        searchType: "web",
        clicks: i,
        impressions: i * 10,
        position: 1,
        ctr: 0.1,
      },
    });
  }
  return { tenant, prop };
}

// ─── 1. Tenant → GscProperty → GscDaily : cascade complète en chaîne ────────

test("supprimer un Tenant cascade sur GscProperty ET GscDaily", async () => {
  const { tenant, prop } = await seedGscTree({ nDaily: 5 });

  // Sanity scopé : l'arbre du tenant est bien en DB.
  assert.equal(await countPropsOfTenant(tenant.id), 1);
  assert.equal(await countDailyOfTenant(tenant.id), 5);

  // DELETE du Tenant. La FK `GscProperty.tenantId ... onDelete: Cascade`
  // emporte la property ; en chaîne, `GscDaily.gscPropertyId ... onDelete:
  // Cascade` emporte les 5 rows daily. Ce double étage est IMPOSSIBLE à
  // valider sur FakePrisma.
  await h.prisma.tenant.delete({ where: { id: tenant.id } });

  // Le tenant lui-même n'existe plus.
  assert.equal(
    await h.prisma.tenant.findUnique({ where: { id: tenant.id } }),
    null,
  );
  // La property a cascadé.
  assert.equal(
    await countPropsOfTenant(tenant.id),
    0,
    "la GscProperty doit cascader avec le Tenant",
  );
  assert.equal(
    await h.prisma.gscProperty.findUnique({ where: { id: prop.id } }),
    null,
  );
  // Les daily ont cascadé en chaîne.
  assert.equal(
    await countDailyOfProp(prop.id),
    0,
    "les GscDaily doivent cascader en chaîne",
  );
});

test("supprimer un Tenant avec PLUSIEURS properties cascade sur toutes", async () => {
  const tenant = await mkTenant();
  const propA = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: "https://multi-a.example/",
      type: "SITE",
      ownershipState: "verified",
    },
  });
  const propB = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: "https://multi-b.example/",
      type: "DOMAIN",
      ownershipState: "pending",
    },
  });
  for (const p of [propA, propB]) {
    await h.prisma.gscDaily.create({
      data: {
        gscPropertyId: p.id,
        date: new Date("2026-05-15T00:00:00Z"),
        query: "kw",
        page: "/",
        clicks: 1,
        impressions: 10,
        position: 1,
        ctr: 0.1,
      },
    });
  }
  assert.equal(await countPropsOfTenant(tenant.id), 2);
  assert.equal(await countDailyOfTenant(tenant.id), 2);

  await h.prisma.tenant.delete({ where: { id: tenant.id } });

  assert.equal(await countPropsOfTenant(tenant.id), 0);
  assert.equal(await countDailyOfProp(propA.id), 0);
  assert.equal(await countDailyOfProp(propB.id), 0);
});

// ─── 2. GscProperty → GscDaily : cascade isolée, le Tenant survit ───────────

test("supprimer une GscProperty cascade sur ses GscDaily, le Tenant survit", async () => {
  const { tenant, prop } = await seedGscTree({ nDaily: 4 });
  assert.equal(await countDailyOfProp(prop.id), 4);

  await h.prisma.gscProperty.delete({ where: { id: prop.id } });

  // Les daily de cette property cascadent.
  assert.equal(await countDailyOfProp(prop.id), 0);
  // Mais le Tenant n'est PAS touché (cascade descendante uniquement).
  const survivor = await h.prisma.tenant.findUnique({
    where: { id: tenant.id },
  });
  assert.ok(survivor, "le Tenant doit survivre à la suppression de sa property");
});

// ─── 3. Isolation : la cascade ne touche QUE le tenant supprimé ─────────────

test("supprimer un Tenant n'affecte PAS les données GSC d'un autre tenant", async () => {
  const a = await seedGscTree({ nDaily: 3, siteUrl: "https://cascade-a.example/" });
  const b = await seedGscTree({ nDaily: 7, siteUrl: "https://cascade-b.example/" });

  assert.equal(await countDailyOfTenant(a.tenant.id), 3);
  assert.equal(await countDailyOfTenant(b.tenant.id), 7);

  // On supprime SEULEMENT le tenant A.
  await h.prisma.tenant.delete({ where: { id: a.tenant.id } });

  // Tenant A et ses données ont disparu.
  assert.equal(await countPropsOfTenant(a.tenant.id), 0);
  assert.equal(await countDailyOfProp(a.prop.id), 0);

  // Tenant B et toutes ses données sont intacts.
  assert.ok(await h.prisma.tenant.findUnique({ where: { id: b.tenant.id } }));
  assert.equal(await countPropsOfTenant(b.tenant.id), 1);
  assert.equal(await countDailyOfProp(b.prop.id), 7);
  const bProp = await h.prisma.gscProperty.findUnique({
    where: { id: b.prop.id },
  });
  assert.ok(bProp, "la property du tenant B doit survivre");
  assert.equal(bProp.tenantId, b.tenant.id);
});

// ─── 4. Contrainte @@unique GSC : (tenantId, siteUrl) ───────────────────────

test("contrainte @@unique GscProperty (tenantId, siteUrl) → P2002 sur doublon", async () => {
  const tenant = await mkTenant();
  const url = `https://dup-${tenant.id}.example/`;
  await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: url,
      type: "SITE",
      ownershipState: "verified",
    },
  });
  // Même (tenantId, siteUrl) → la vraie contrainte SQL doit refuser.
  await assert.rejects(
    () =>
      h.prisma.gscProperty.create({
        data: {
          tenantId: tenant.id,
          siteUrl: url,
          type: "SITE",
          ownershipState: "pending",
        },
      }),
    (err: unknown) => (err as { code?: string }).code === "P2002",
    "un (tenantId, siteUrl) en doublon doit lever P2002",
  );
  assert.equal(await countPropsOfTenant(tenant.id), 1);
});

test("le même siteUrl est autorisé pour DEUX tenants différents", async () => {
  // @@unique([tenantId, siteUrl]) : la contrainte est SCOPÉE au tenant.
  const t1 = await mkTenant("t1");
  const t2 = await mkTenant("t2");
  const shared = `https://shared-${t1.id}-${t2.id}.example/`;
  await h.prisma.gscProperty.create({
    data: {
      tenantId: t1.id,
      siteUrl: shared,
      type: "SITE",
      ownershipState: "verified",
    },
  });
  // Même siteUrl, AUTRE tenant → doit passer.
  await h.prisma.gscProperty.create({
    data: {
      tenantId: t2.id,
      siteUrl: shared,
      type: "SITE",
      ownershipState: "verified",
    },
  });
  assert.equal(await countPropsOfTenant(t1.id), 1);
  assert.equal(await countPropsOfTenant(t2.id), 1);
});

test("FK GscProperty.tenantId : insérer avec un tenantId inexistant → P2003", async () => {
  // La FK doit refuser une property orpheline (vrai contrôle référentiel).
  await assert.rejects(
    () =>
      h.prisma.gscProperty.create({
        data: {
          tenantId: "tenant_inexistant_xyz",
          siteUrl: "https://orphan.example/",
          type: "SITE",
          ownershipState: "verified",
        },
      }),
    (err: unknown) => (err as { code?: string }).code === "P2003",
    "une GscProperty sans Tenant parent doit lever P2003 (FK violation)",
  );
});

test("FK GscDaily.gscPropertyId : insérer avec une property inexistante → P2003", async () => {
  await assert.rejects(
    () =>
      h.prisma.gscDaily.create({
        data: {
          gscPropertyId: "gsc_inexistant_xyz",
          date: new Date("2026-05-15T00:00:00Z"),
          query: "kw",
          page: "/",
          clicks: 1,
          impressions: 10,
          position: 1,
          ctr: 0.1,
        },
      }),
    (err: unknown) => (err as { code?: string }).code === "P2003",
    "une GscDaily sans GscProperty parente doit lever P2003",
  );
});
