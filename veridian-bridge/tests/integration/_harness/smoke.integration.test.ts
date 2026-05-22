/**
 * ════════════════════════════════════════════════════════════════════════════
 * smoke.integration.test.ts — test de RÉFÉRENCE du harness d'intégration
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ce fichier a deux rôles :
 *
 *   1. PREUVE que le harness marche : si `compose/test.yml` n'est pas up, ou
 *      si `prisma migrate deploy` échoue, ou si une contrainte SQL est cassée,
 *      ce fichier devient ROUGE. C'est le garde-fou du socle.
 *
 *   2. PATTERN de référence : T2..T5 copient la structure de ce fichier
 *      (`before`/`after`/`beforeEach`, usage de `seedTenant`, assertions sur
 *      `h.prisma`, vérification d'une erreur `P2002` réelle).
 *
 * Lance-le avec : `npm run test:integration` (services up) ou
 *                  `npm run test:integration:local` (gère le compose).
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  seedTenant,
  seedSite,
  type BridgeHarness,
} from "./index.js";

let h: BridgeHarness;

// Boot UNE fois : le boot applique les migrations + connecte Prisma (~1s).
before(async () => {
  h = await bootBridgeWithRealDB();
});

// Toujours fermer — sinon le port et la connexion Prisma fuient.
after(async () => {
  await h.close();
});

// Isolation : DB vierge avant chaque test.
beforeEach(async () => {
  await resetDb(h.prisma);
});

// ─── 1. Le bridge répond vraiment ───────────────────────────────────────────

test("smoke: l'instance bridge répond sur /health", async () => {
  const res = await fetch(`${h.url}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "ok");
});

// ─── 2. Prisma écrit vraiment dans Postgres ─────────────────────────────────

test("smoke: seedTenant persiste une row lisible via un autre query Prisma", async () => {
  const created = await seedTenant(h.prisma, {
    slug: "smoke-acme",
    plan: "pro",
  });

  // Relire indépendamment : prouve que c'est en DB, pas en mémoire.
  const reread = await h.prisma.tenant.findUnique({
    where: { id: created.id },
  });
  assert.ok(reread, "le tenant doit être relisible depuis Postgres");
  assert.equal(reread.slug, "smoke-acme");
  assert.equal(reread.plan, "pro");
  assert.equal(reread.status, "active"); // default DB respecté

  // Le compteur de rows reflète l'INSERT réel.
  const count = await h.prisma.tenant.count();
  assert.equal(count, 1);
});

// ─── 3. LA preuve : une contrainte SQL réelle est appliquée ─────────────────

test("smoke: contrainte @@unique sur workspaceId → vraie erreur P2002", async () => {
  // Premier tenant avec un workspaceId fixe.
  await seedTenant(h.prisma, { workspaceId: "ws_smoke_dup" });

  // Deuxième tenant avec le MÊME workspaceId → Postgres doit refuser.
  // Avec FakePrismaClient ce test ne prouverait rien ; ici c'est la vraie
  // contrainte `Tenant_workspaceId_key` qui parle.
  await assert.rejects(
    () => seedTenant(h.prisma, { workspaceId: "ws_smoke_dup" }),
    (err: unknown) => {
      const e = err as { code?: string; meta?: { target?: unknown } };
      assert.equal(e.code, "P2002", "doit être une violation d'unicité Prisma");
      return true;
    },
    "un workspaceId en doublon doit lever P2002",
  );

  // La 2e insertion a bien échoué : toujours 1 row.
  assert.equal(await h.prisma.tenant.count(), 1);
});

test("smoke: contrainte @@unique sur hubTenantId → vraie erreur P2002", async () => {
  await seedTenant(h.prisma, { hubTenantId: "hub_smoke_dup" });
  await assert.rejects(
    () => seedTenant(h.prisma, { hubTenantId: "hub_smoke_dup" }),
    (err: unknown) => (err as { code?: string }).code === "P2002",
  );
});

// ─── 4. La cascade FK réelle fonctionne ─────────────────────────────────────

test("smoke: onDelete Cascade — supprimer un Tenant supprime ses Sites", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id);
  await seedSite(h.prisma, tenant.id);
  assert.equal(await h.prisma.site.count(), 2);

  // DELETE du tenant → la FK `Site.tenantId ... onDelete: Cascade` doit
  // emporter les 2 sites. Comportement impossible à vérifier sur un fake.
  await h.prisma.tenant.delete({ where: { id: tenant.id } });

  assert.equal(await h.prisma.site.count(), 0, "les sites doivent cascader");
  assert.equal(await h.prisma.tenant.count(), 0);
});

// ─── 5. resetDb isole bien les tests ────────────────────────────────────────

test("smoke: resetDb a bien vidé la table (test précédent invisible ici)", async () => {
  // Si resetDb ne marchait pas, on verrait les rows des tests ci-dessus.
  assert.equal(await h.prisma.tenant.count(), 0);
  assert.equal(await h.prisma.site.count(), 0);
});
