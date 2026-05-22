/**
 * ════════════════════════════════════════════════════════════════════════════
 * Harness des tests d'INTÉGRATION du bridge Veridian
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Construit par le ticket T1 (SOCLE). T2..T5 écrivent leurs tests AVEC cette
 * API — ils n'ont PAS à toucher ce dossier.
 *
 * ─── Le problème qu'on résout ───────────────────────────────────────────────
 *
 * Les tests `*.test.ts` historiques tournent contre `FakePrismaClient`
 * (in-memory, 600 lignes maison). Un test qui passe sur le fake ne garantit
 * RIEN sur Postgres : contrainte `@@unique`, erreur `P2002`, cascade FK,
 * type `@db.Date`, transactions — tout ça n'existe pas dans le fake.
 *
 * Le harness boote une instance Express du bridge connectée à un VRAI Postgres
 * (`compose/test.yml` en local, service `postgres` en CI). `prisma migrate
 * deploy` est appliqué pour de vrai. Si la migration échoue, le test échoue.
 *
 * ─── API publique (ce que T2..T5 utilisent) ─────────────────────────────────
 *
 *   bootBridgeWithRealDB(opts?)        → { url, prisma, store, close }
 *   bootBridgeWithRealStaminads(opts?) → idem + { staminadsUrl }
 *   resetDb(prisma)                    → TRUNCATE toutes les tables
 *   seedTenant(prisma, overrides?)     → crée une row Tenant réelle
 *   seedSite(prisma, tenantId, ovr?)   → crée une row Site réelle
 *   getTestDatabaseUrl()               → URL Postgres de test résolue
 *
 * ─── Pattern d'usage type (à copier dans tests/integration/<feature>/) ──────
 *
 *   import { test, before, after, beforeEach } from "node:test";
 *   import assert from "node:assert/strict";
 *   import {
 *     bootBridgeWithRealDB, resetDb, seedTenant, type BridgeHarness,
 *   } from "../_harness/index.js";
 *
 *   let h: BridgeHarness;
 *
 *   before(async () => { h = await bootBridgeWithRealDB(); });
 *   after(async () => { await h.close(); });
 *   beforeEach(async () => { await resetDb(h.prisma); });
 *
 *   test("contrainte unique workspaceId réelle", async () => {
 *     await seedTenant(h.prisma, { workspaceId: "ws_dup" });
 *     await assert.rejects(
 *       () => seedTenant(h.prisma, { workspaceId: "ws_dup" }),
 *       (err: unknown) => (err as { code?: string }).code === "P2002",
 *     );
 *   });
 *
 * ─── Règles pour T2..T5 ─────────────────────────────────────────────────────
 *
 *   1. Nom de fichier : `*.integration.test.ts` (jamais `*.test.ts` — ces
 *      derniers tournent dans le pre-push rapide, sans Postgres).
 *   2. `before()` / `after()` pour boot/close UNE fois par fichier (le boot
 *      coûte ~1s, ne le refais pas par test).
 *   3. `beforeEach(() => resetDb(h.prisma))` pour l'isolation inter-tests.
 *   4. Ne touche JAMAIS `process.env` à la main — le harness gère la config.
 *   5. Utilise `h.prisma` pour les assertions DB directes (vérifier qu'une row
 *      a bien été écrite), `h.url` pour les requêtes HTTP contre le bridge.
 *
 * ════════════════════════════════════════════════════════════════════════════
 */

import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express, { type Express } from "express";
import { PrismaClient } from "@prisma/client";

import { createApp, type BridgeConfig } from "../../../src/app.js";
import { registerGscRoutes } from "../../../src/gsc/routes.js";
import { registerFormsRoutes } from "../../../src/forms/routes.js";
import { registerPushRoutes } from "../../../src/push/routes.js";
import { registerSettingsRoutes } from "../../../src/settings/routes.js";
import { setPrismaClientForTests } from "../../../src/db/prisma.js";
import type { Request, Response, NextFunction } from "express";
import { PrismaTenantStore, ensureOwnerTable } from "./prisma-tenant-store.js";
import type { TenantStore } from "../../../src/hub/store.js";

// ─── Constantes partagées (T2..T5 peuvent les importer) ─────────────────────

/** Secret HMAC Hub utilisé par tous les tests d'intégration. 32+ chars. */
export const TEST_HMAC_SECRET = "veridian-integration-hmac-secret-32c!";
/** Clé admin Bearer pour les routes `/api/admin/*`. 32+ chars. */
export const TEST_ADMIN_KEY = "veridian-integration-admin-key-32ch!";
/** Clé AES-256-GCM (64 hex) pour le chiffrement des tokens GSC. */
export const TEST_ENCRYPTION_KEY = "f".repeat(64);

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Racine du package bridge (où vit `prisma/schema.prisma`). */
const BRIDGE_ROOT = resolve(__dirname, "../../..");
const SCHEMA_PATH = resolve(BRIDGE_ROOT, "prisma/schema.prisma");

/**
 * Résout l'URL Postgres de test.
 *
 * Priorité :
 *   1. `BRIDGE_TEST_DATABASE_URL` (CI : pointe sur le service `postgres`)
 *   2. Défaut local : `compose/test.yml` (port décalé 55432)
 *
 * Le harness force ENSUITE `process.env.BRIDGE_DATABASE_URL` à cette valeur,
 * parce que `prisma migrate deploy` et le datasource Prisma lisent cette ENV.
 */
export function getTestDatabaseUrl(): string {
  return (
    process.env.BRIDGE_TEST_DATABASE_URL ??
    "postgresql://bridge_test:bridge_test_pwd@127.0.0.1:55432/veridian_bridge_test"
  );
}

/**
 * Résout l'URL ClickHouse de test (pour `bootBridgeWithRealStaminads`).
 */
export function getTestClickhouseHost(): string {
  return process.env.CLICKHOUSE_TEST_HOST ?? "http://127.0.0.1:58123";
}

let migrationsApplied = false;

/**
 * Applique les migrations Prisma sur la DB de test. RÉEL :
 * `prisma migrate deploy`. Si une migration est cassée → throw → test rouge.
 *
 * Idempotent au sein d'un même process : `migrate deploy` ne ré-applique pas
 * les migrations déjà présentes, et on garde un flag pour éviter le coût du
 * spawn quand plusieurs fichiers de test tournent dans le même worker.
 */
function applyMigrations(databaseUrl: string): void {
  if (migrationsApplied) return;
  execFileSync(
    "npx",
    ["prisma", "migrate", "deploy", "--schema", SCHEMA_PATH],
    {
      cwd: BRIDGE_ROOT,
      env: { ...process.env, BRIDGE_DATABASE_URL: databaseUrl },
      stdio: "pipe",
    },
  );
  migrationsApplied = true;
}

// ─── Types publics ──────────────────────────────────────────────────────────

/** Handle retourné par `bootBridgeWithRealDB`. */
export interface BridgeHarness {
  /** URL HTTP de l'instance bridge (port éphémère, ex `http://127.0.0.1:43117`). */
  url: string;
  /** Client Prisma RÉEL pointé sur la DB de test. À utiliser pour les
   *  assertions DB directes et le seeding. */
  prisma: PrismaClient;
  /** Store Hub réel (Postgres-backed). Câblé dans les routes `/api/tenants/*`.
   *  Exposé pour les tests qui veulent vérifier l'état via le store. */
  store: TenantStore;
  /** Ferme le serveur HTTP + déconnecte Prisma. À appeler dans `after()`. */
  close: () => Promise<void>;
}

/** Handle retourné par `bootBridgeWithRealStaminads` (= BridgeHarness + staminads). */
export interface StaminadsBridgeHarness extends BridgeHarness {
  /** URL de la staminads connectée (réelle si fournie, sinon faux serveur). */
  staminadsUrl: string;
}

/** Options de `bootBridgeWithRealDB`. */
export interface BootOptions {
  /**
   * URL staminads à coller dans la config. Par défaut un endpoint inerte
   * (`http://127.0.0.1:9`) — les tests qui n'appellent pas staminads ne le
   * touchent jamais. Fournir une vraie URL pour les tests score/push.
   */
  staminadsUrl?: string;
  /**
   * Bypass HMAC sur les routes `/api/tenants/*`. Default `false` — les tests
   * Hub doivent signer leurs requêtes (cf `signedFetch` du harness Hub).
   * Mettre `true` seulement pour des tests qui ne portent pas sur la sécurité.
   */
  skipHmac?: boolean;
  /**
   * Hook staminads injecté dans `/api/tenants/provision`. Par défaut un hook
   * déterministe qui retourne des ids `ws_it_*` / `sk_it_*` SANS toucher le
   * réseau. Les tests provision peuvent l'override pour simuler une panne.
   */
  createStaminadsWorkspace?: NonNullable<
    BridgeConfig["hub"]
  >["createStaminadsWorkspace"];
  /**
   * Hook stats `/api/tenants/:id/health`. Default absent.
   */
  loadStats?: NonNullable<BridgeConfig["hub"]>["loadStats"];
}

// ─── requireAdmin partagé ───────────────────────────────────────────────────

function makeRequireAdmin(adminKey: string) {
  return function requireAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer" });
      return;
    }
    if (auth.slice("Bearer ".length).trim() !== adminKey) {
      res.status(403).json({ error: "invalid_admin_key" });
      return;
    }
    next();
  };
}

// ─── Boot ───────────────────────────────────────────────────────────────────

/**
 * Démarre une instance Express du bridge connectée à un VRAI Postgres.
 *
 * Ce que la fonction fait, dans l'ordre :
 *   1. Résout l'URL Postgres de test (`getTestDatabaseUrl()`).
 *   2. Applique `prisma migrate deploy` sur cette DB (RÉEL — throw si KO).
 *   3. Crée la table annexe `TenantOwner` (scaffolding test, cf prisma-tenant-store).
 *   4. Instancie un vrai `PrismaClient` pointé sur la DB de test, et le
 *      pousse dans le singleton `src/db/prisma.ts` via `setPrismaClientForTests`
 *      (les modules GSC/Forms/Push partagent ce singleton).
 *   5. Boote `createApp()` (routes de base + Hub HMAC avec `PrismaTenantStore`).
 *   6. Monte les routes GSC + Forms + Push (comme `src/index.ts` en prod).
 *   7. Écoute sur un port éphémère.
 *
 * @returns `{ url, prisma, store, close }`. Toujours appeler `close()` dans
 *          `after()` même si un test crash — sinon le port fuit.
 *
 * @example
 *   const h = await bootBridgeWithRealDB();
 *   try {
 *     await seedTenant(h.prisma, { slug: "acme" });
 *     const res = await fetch(`${h.url}/health`);
 *     assert.equal(res.status, 200);
 *   } finally {
 *     await h.close();
 *   }
 */
export async function bootBridgeWithRealDB(
  opts: BootOptions = {},
): Promise<BridgeHarness> {
  const databaseUrl = getTestDatabaseUrl();

  // Prisma datasource + `migrate deploy` lisent BRIDGE_DATABASE_URL.
  process.env.BRIDGE_DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = "test";

  // 1+2. Migrations RÉELLES.
  applyMigrations(databaseUrl);

  // 3. Client Prisma réel.
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: ["error"],
  });
  await prisma.$connect();

  // Table annexe owner (idempotent).
  await ensureOwnerTable(prisma);

  // Le singleton getPrisma() est consommé par GSC/Forms/Push : on le pointe
  // sur NOTRE client de test pour que les routes tapent la bonne DB.
  setPrismaClientForTests(prisma);

  // 4. Store Hub réel.
  const store = new PrismaTenantStore(prisma);

  // Hook staminads déterministe par défaut (aucun réseau).
  let provisionCounter = 0;
  const defaultStaminadsHook = async (input: {
    hubTenantId: string;
  }) => {
    provisionCounter += 1;
    return {
      workspaceId: `ws_it_${provisionCounter}_${input.hubTenantId.slice(0, 6)}`,
      apiKey: `sk_it_${provisionCounter}_${input.hubTenantId.slice(0, 8)}`,
    };
  };

  // 5. App de base + Hub HMAC.
  const app: Express = createApp({
    staminadsUrl: opts.staminadsUrl ?? "http://127.0.0.1:9",
    adminEmail: "admin@veridian.local",
    adminPassword: "integration-test-pass-2026",
    veridianAdminApiKey: TEST_ADMIN_KEY,
    hub: {
      hmacSecret: TEST_HMAC_SECRET,
      skipHmac: opts.skipHmac ?? false,
      store,
      createStaminadsWorkspace:
        opts.createStaminadsWorkspace ?? defaultStaminadsHook,
      publicDashboardUrl: "https://analytics.app.veridian.site",
      loadStats: opts.loadStats,
    },
  });

  // 6. Routes GSC / Forms / Push — comme `src/index.ts`.
  const requireAdmin = makeRequireAdmin(TEST_ADMIN_KEY);

  registerGscRoutes(app, {
    prisma,
    oauthConfig: {
      clientId: "it-client-id",
      clientSecret: "it-client-secret",
      redirectUri: "https://bridge.test/api/admin/gsc/oauth-callback",
      encryptionKey: TEST_ENCRYPTION_KEY,
    },
    requireAdmin,
    adminApiKey: TEST_ADMIN_KEY,
  });

  registerFormsRoutes(app, {
    prisma,
    requireAdmin,
    staminadsUrl: opts.staminadsUrl ?? "http://127.0.0.1:9",
  });

  registerPushRoutes(app, { prisma, requireAdmin });

  registerSettingsRoutes(app, {
    prisma,
    requireAdmin,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });

  // 7. Listen sur port éphémère.
  const { url, closeServer } = await listen(app);

  return {
    url,
    prisma,
    store,
    close: async () => {
      await closeServer();
      setPrismaClientForTests(null);
      await prisma.$disconnect();
    },
  };
}

/**
 * Variante de `bootBridgeWithRealDB` qui connecte AUSSI une staminads.
 *
 * Pour les tests T5 (score / tenant-status) qui doivent vérifier l'agrégation
 * réelle des données analytics.
 *
 * Deux modes :
 *   - Si `staminadsUrl` est fourni dans `opts`, le bridge l'utilise tel quel
 *     (ex : une vraie engine staminads montée par `compose/test.yml` + un
 *     workspace seedé en ClickHouse).
 *   - Sinon, le harness démarre un faux serveur staminads HTTP minimal (le
 *     même `FakeStaminads` que les tests unitaires) — utile quand le test
 *     veut juste un endpoint qui répond, sans monter ClickHouse.
 *
 * Note : "réel" ici veut dire "vrai Postgres" (toujours) + "vraie staminads
 * si fournie". Le harness NE monte PAS ClickHouse lui-même — c'est à la CI /
 * `compose/test.yml` de le faire, et au test de fournir l'URL via `opts` ou
 * la variable `STAMINADS_TEST_URL`.
 *
 * @example
 *   // Avec staminads réelle (CI a monté l'engine) :
 *   const h = await bootBridgeWithRealStaminads({
 *     staminadsUrl: process.env.STAMINADS_TEST_URL,
 *   });
 */
export async function bootBridgeWithRealStaminads(
  opts: BootOptions = {},
): Promise<StaminadsBridgeHarness> {
  const explicitUrl = opts.staminadsUrl ?? process.env.STAMINADS_TEST_URL;

  if (explicitUrl) {
    const base = await bootBridgeWithRealDB({ ...opts, staminadsUrl: explicitUrl });
    return { ...base, staminadsUrl: explicitUrl };
  }

  // Pas de staminads réelle fournie → faux serveur HTTP local.
  const { FakeStaminads } = await import("../../helpers/fake-staminads.js");
  const fake = new FakeStaminads();
  const fakeUrl = await fake.start();

  const base = await bootBridgeWithRealDB({ ...opts, staminadsUrl: fakeUrl });
  return {
    ...base,
    staminadsUrl: fakeUrl,
    close: async () => {
      await base.close();
      await fake.stop();
    },
  };
}

// ─── Reset ──────────────────────────────────────────────────────────────────

/**
 * Liste des tables de l'app, dans un ordre qui SERAIT respectueux des FK —
 * mais on TRUNCATE avec `CASCADE` donc l'ordre n'importe pas. On garde la
 * liste explicite (pas de découverte dynamique) pour ne JAMAIS toucher une
 * table système Prisma type `_prisma_migrations`.
 */
const APP_TABLES = [
  "TenantOwner",
  "TenantCredential",
  "TenantSettings",
  "PushNotification",
  "PushSubscription",
  "LeadSession",
  "FormSubmission",
  "FormSchema",
  "Lead",
  "Site",
  "GscDaily",
  "GscProperty",
  "Tenant",
] as const;

/**
 * Vide TOUTES les tables applicatives entre deux tests. Isolation stricte.
 *
 * `TRUNCATE ... RESTART IDENTITY CASCADE` :
 *   - vide tout en un seul appel SQL (rapide)
 *   - `CASCADE` gère les FK sans se soucier de l'ordre
 *   - NE touche PAS `_prisma_migrations` → les migrations restent appliquées,
 *     pas besoin de re-`migrate deploy` entre les tests
 *
 * À appeler dans `beforeEach()`.
 *
 * @example beforeEach(async () => { await resetDb(h.prisma); });
 */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const quoted = APP_TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`,
  );
}

// ─── Seed helpers ───────────────────────────────────────────────────────────

let seedCounter = 0;

/** Champs surchargeables de `seedTenant`. Tout est optionnel. */
export interface SeedTenantOverrides {
  workspaceId?: string;
  slug?: string;
  name?: string;
  hubTenantId?: string | null;
  plan?: string;
  planSource?: string | null;
  status?: string;
  apiKey?: string | null;
  suspendedAt?: Date | null;
  softDeletedAt?: Date | null;
}

/**
 * Crée une row `Tenant` RÉELLE en Postgres et la retourne.
 *
 * Par défaut tous les champs uniques (`workspaceId`, `slug`) reçoivent une
 * valeur fraîche à chaque appel — deux `seedTenant()` sans override ne
 * collisionnent jamais. Pour TESTER une collision unique, passe explicitement
 * la même valeur deux fois (cf `smoke.integration.test.ts`).
 *
 * @returns la row Tenant créée (type Prisma `Tenant`).
 *
 * @example
 *   const t = await seedTenant(h.prisma);                  // tenant aléatoire
 *   const acme = await seedTenant(h.prisma, { slug: "acme", plan: "pro" });
 */
export async function seedTenant(
  prisma: PrismaClient,
  overrides: SeedTenantOverrides = {},
) {
  seedCounter += 1;
  const n = seedCounter;
  return prisma.tenant.create({
    data: {
      workspaceId: overrides.workspaceId ?? `ws_seed_${n}`,
      slug: overrides.slug ?? `seed-tenant-${n}`,
      name: overrides.name ?? `Seed Tenant ${n}`,
      hubTenantId:
        overrides.hubTenantId === undefined
          ? `hub_seed_${n}`
          : overrides.hubTenantId,
      plan: overrides.plan ?? "free",
      planSource: overrides.planSource ?? "manual",
      status: overrides.status ?? "active",
      apiKey: overrides.apiKey === undefined ? `sk_seed_${n}` : overrides.apiKey,
      suspendedAt: overrides.suspendedAt ?? null,
      softDeletedAt: overrides.softDeletedAt ?? null,
    },
  });
}

/** Champs surchargeables de `seedSite`. */
export interface SeedSiteOverrides {
  siteKey?: string;
  domain?: string;
  name?: string;
}

/**
 * Crée une row `Site` RÉELLE rattachée à un Tenant existant.
 *
 * Utile pour les tests Forms (l'ingest cherche un Site par `siteKey`) et Push.
 *
 * @param tenantId  id d'un Tenant déjà seedé (cf `seedTenant`).
 * @returns la row Site créée.
 *
 * @example
 *   const t = await seedTenant(h.prisma);
 *   const site = await seedSite(h.prisma, t.id, { siteKey: "pk_test" });
 */
export async function seedSite(
  prisma: PrismaClient,
  tenantId: string,
  overrides: SeedSiteOverrides = {},
) {
  seedCounter += 1;
  const n = seedCounter;
  return prisma.site.create({
    data: {
      tenantId,
      siteKey: overrides.siteKey ?? `sk_site_${n}`,
      domain: overrides.domain ?? `seed-site-${n}.veridian.site`,
      name: overrides.name ?? `Seed Site ${n}`,
    },
  });
}

// ─── Interne ────────────────────────────────────────────────────────────────

/** Démarre `app` sur un port éphémère 127.0.0.1. */
function listen(
  app: Express,
): Promise<{ url: string; closeServer: () => Promise<void> }> {
  return new Promise((res) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      res({
        url: `http://127.0.0.1:${addr.port}`,
        closeServer: () =>
          new Promise<void>((ok, ko) =>
            srv.close((e) => (e ? ko(e) : ok())),
          ),
      });
    });
  });
}
