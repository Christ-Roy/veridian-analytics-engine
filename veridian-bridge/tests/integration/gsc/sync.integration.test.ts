/**
 * ════════════════════════════════════════════════════════════════════════════
 * sync.integration.test.ts — sync GSC → GscDaily contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T4. Couvre `src/gsc/sync.ts` (`syncProperty`, `syncAllVerified`).
 *
 * Ce que ça PROUVE (vs FakePrisma) :
 *
 *   - L'API Google Search Console est mockée au niveau HTTP — aucun réseau
 *     réel — MAIS `syncProperty` écrit RÉELLEMENT des rows `GscDaily` en
 *     Postgres. On les relit avec un second query Prisma pour le prouver.
 *   - Re-sync : `syncProperty` fait un `deleteMany` puis `createMany` sur la
 *     fenêtre de dates. Un second sync ne produit PAS de doublons — c'est la
 *     vraie contrainte `@@unique([gscPropertyId, date, query, page, country,
 *     device, searchType])` qui le garantit (insérable seulement parce que
 *     `skipDuplicates` + delete préalable). FakePrisma ne prouverait rien.
 *   - Backoff : un mock qui répond 429 puis 200 doit déclencher les retries
 *     internes (max 3) et finir vert. Un 5xx persistant doit remonter dans
 *     `result.errors` sans planter le process.
 *   - `lastSyncAt` est mis à jour en DB après chaque sync.
 *
 * Note : `syncProperty` filtre les rows à `r.query && r.page && r.date` — une
 * row GSC sans query/page (agrégat) est ignorée. Les fixtures en tiennent compte.
 *
 * ─── Isolation ──────────────────────────────────────────────────────────────
 *
 * Ce fichier est 100% AUTO-ISOLANT — il ne dépend d'aucun `resetDb()` ni d'un
 * ordre d'exécution. Chaque test seede son propre Tenant via `mkTenant` (id
 * unique cross-process) et n'assert QUE sur des entités scopées (`findUnique`,
 * `count({ where: { tenantId / gscPropertyId } })`). Conséquence : les tests
 * restent corrects même si les fichiers d'intégration se chevauchent sur le
 * Postgres partagé. Le runner `scripts/run-integration.mjs` (T3) exécute
 * en plus chaque fichier dans son propre process + sa propre base jetable,
 * mais la justesse de ce fichier n'en dépend pas.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  seedTenant,
  TEST_ENCRYPTION_KEY,
  type BridgeHarness,
} from "../_harness/index.js";
import {
  syncProperty,
  syncAllVerified,
  encryptTokens,
  type GscRawRow,
  type OauthConfig,
  type OauthTokens,
} from "../../../src/gsc/index.js";

const OAUTH_CFG: OauthConfig = {
  clientId: "it-client-id",
  clientSecret: "it-client-secret",
  redirectUri: "https://bridge.test/cb",
  encryptionKey: TEST_ENCRYPTION_KEY,
};

// `now()` figé : la fenêtre de sync est [now-2j-(days-1) ; now-2j].
// On fixe une date pour pouvoir générer des fixtures dans la fenêtre.
const FIXED_NOW = new Date("2026-05-20T12:00:00Z");

/** Renvoie un token valide chiffré, prêt à coller dans GscProperty.oauthAccount. */
function encryptedValidToken(): object {
  const tokens: OauthTokens = {
    access_token: "AT_valid",
    refresh_token: "RT_valid",
    expires_at: Date.now() + 3600_000,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    token_type: "Bearer",
  };
  return encryptTokens(tokens, TEST_ENCRYPTION_KEY) as unknown as object;
}

/** Mock `fetch` GSC : répond toujours 200 avec `rows` aux query searchAnalytics. */
function mockGscOk(rows: GscRawRow[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url.includes("searchconsole.googleapis.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ rows }),
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "not_mocked" }),
      text: async () => "not_mocked",
    } as unknown as Response;
  }) as typeof fetch;
}

/**
 * Mock `fetch` GSC qui renvoie une séquence de statuts puis 200. Sert à
 * exercer le backoff : ex `[429, 200]` → un retry puis succès.
 */
function mockGscSequence(
  statuses: number[],
  okRows: GscRawRow[],
): { fetch: typeof fetch; calls: () => number } {
  let call = 0;
  const impl = (async (input: string | URL | Request) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (!url.includes("searchconsole.googleapis.com")) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "not_mocked",
      } as unknown as Response;
    }
    const status = statuses[call] ?? 200;
    call += 1;
    if (status === 200) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ rows: okRows }),
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: false,
      status,
      json: async () => ({ error: "transient" }),
      text: async () => `transient_${status}`,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: impl, calls: () => call };
}

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

// Pas de `resetDb()` : ce fichier est 100% auto-isolant. Chaque test seede
// un Tenant à id unique (`mkTenant`) et n'assert QUE sur des entités scopées
// (`where` sur tenantId / gscPropertyId, `findUnique`). Aucune dépendance à
// l'état global → robuste même si les fichiers d'intégration se chevauchent.

/** Nombre de GscDaily d'une property précise (compte SCOPÉ). */
function dailyCount(gscPropertyId: string): Promise<number> {
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


/** Seed un Tenant + une GscProperty `verified` avec token chiffré valide. */
async function seedVerifiedProperty(siteUrl = "https://example.com/") {
  const tenant = await mkTenant();
  const prop = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl,
      type: "SITE",
      ownershipState: "verified",
      oauthAccount: encryptedValidToken(),
    },
  });
  return { tenant, prop };
}

// ─── 1. sync upsert réel : les rows arrivent vraiment en Postgres ───────────

test("syncProperty: les rows GSC mockées sont RÉELLEMENT upsertées en GscDaily", async () => {
  const { prop } = await seedVerifiedProperty();

  // 2 rows dans la fenêtre [2026-05-12 ; 2026-05-18] (now-2j = 2026-05-18).
  const rows: GscRawRow[] = [
    {
      keys: ["2026-05-15", "veridian seo", "/pricing", "fra", "DESKTOP"],
      clicks: 25,
      impressions: 300,
      ctr: 0.083,
      position: 3.2,
    },
    {
      keys: ["2026-05-16", "veridian analytics", "/", "usa", "MOBILE"],
      clicks: 10,
      impressions: 200,
      ctr: 0.05,
      position: 5.1,
    },
  ];

  const result = await syncProperty(h.prisma, prop.id, {
    days: 7,
    oauthConfig: OAUTH_CFG,
    fetchImpl: mockGscOk(rows),
    now: () => FIXED_NOW,
  });

  assert.equal(result.upserted, 2);
  assert.deepEqual(result.errors, []);

  // ─── La preuve : relire les rows depuis Postgres ──────────────────────────
  const daily = await h.prisma.gscDaily.findMany({
    where: { gscPropertyId: prop.id },
    orderBy: { date: "asc" },
  });
  assert.equal(daily.length, 2, "2 rows doivent être en DB");

  assert.equal(daily[0].query, "veridian seo");
  assert.equal(daily[0].page, "/pricing");
  assert.equal(daily[0].country, "fra");
  assert.equal(daily[0].device, "DESKTOP");
  assert.equal(daily[0].searchType, "web");
  assert.equal(daily[0].clicks, 25);
  assert.equal(daily[0].impressions, 300);
  // `@db.Date` : la colonne stocke une date sans heure.
  assert.equal(daily[0].date.toISOString().slice(0, 10), "2026-05-15");

  assert.equal(daily[1].query, "veridian analytics");
  assert.equal(daily[1].clicks, 10);

  // lastSyncAt doit être renseigné après le sync.
  const reread = await h.prisma.gscProperty.findUnique({
    where: { id: prop.id },
  });
  assert.ok(reread?.lastSyncAt, "lastSyncAt doit être positionné");
});

test("syncProperty: les rows sans query/page (agrégats GSC) sont filtrées", async () => {
  const { prop } = await seedVerifiedProperty();
  const rows: GscRawRow[] = [
    // valide
    {
      keys: ["2026-05-15", "kw", "/p", "fra", "DESKTOP"],
      clicks: 1,
      impressions: 10,
      ctr: 0.1,
      position: 1,
    },
    // query vide → filtrée par syncProperty
    {
      keys: ["2026-05-15", "", "/p", "fra", "DESKTOP"],
      clicks: 9,
      impressions: 90,
      ctr: 0.1,
      position: 2,
    },
  ];
  const result = await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mockGscOk(rows),
    now: () => FIXED_NOW,
  });
  assert.equal(result.upserted, 1, "seule la row complète est upsertée");
  assert.equal(await dailyCount(prop.id), 1);
});

// ─── 2. Re-sync idempotent : vraie contrainte @@unique, pas de doublons ─────

test("syncProperty: re-sync identique → idempotent, pas de doublons en DB", async () => {
  const { prop } = await seedVerifiedProperty();
  const rows: GscRawRow[] = [
    {
      keys: ["2026-05-15", "veridian seo", "/pricing", "fra", "DESKTOP"],
      clicks: 25,
      impressions: 300,
      ctr: 0.083,
      position: 3.2,
    },
  ];

  // Premier sync.
  await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mockGscOk(rows),
    now: () => FIXED_NOW,
  });
  assert.equal(await dailyCount(prop.id), 1);

  // Second sync, MÊMES données. Le `deleteMany` + `createMany` doit aboutir
  // à exactement 1 row (et pas 2). Avec FakePrisma la contrainte unique
  // n'existerait pas — ici c'est `GscDaily_..._key` qui parle.
  await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mockGscOk(rows),
    now: () => FIXED_NOW,
  });
  assert.equal(
    await dailyCount(prop.id),
    1,
    "un re-sync ne doit pas dupliquer la row",
  );
});

test("syncProperty: re-sync avec valeurs modifiées → la row reflète les NOUVELLES données", async () => {
  const { prop } = await seedVerifiedProperty();

  await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mockGscOk([
      {
        keys: ["2026-05-15", "kw", "/p", "fra", "DESKTOP"],
        clicks: 10,
        impressions: 100,
        ctr: 0.1,
        position: 5,
      },
    ]),
    now: () => FIXED_NOW,
  });

  // Re-sync avec des clics différents pour la même clé unique.
  await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mockGscOk([
      {
        keys: ["2026-05-15", "kw", "/p", "fra", "DESKTOP"],
        clicks: 999,
        impressions: 100,
        ctr: 0.99,
        position: 1,
      },
    ]),
    now: () => FIXED_NOW,
  });

  const daily = await h.prisma.gscDaily.findMany({
    where: { gscPropertyId: prop.id },
  });
  assert.equal(daily.length, 1, "toujours 1 row pour la même clé unique");
  assert.equal(daily[0].clicks, 999, "la row reflète les données du dernier sync");
});

test("contrainte @@unique GscDaily: 2 rows identiques sur 7 dimensions → P2002", async () => {
  // Vérifie directement la vraie contrainte SQL (pas via sync, en createMany
  // sans skipDuplicates). C'est la garantie sous-jacente de l'idempotence.
  const { prop } = await seedVerifiedProperty();
  const base = {
    gscPropertyId: prop.id,
    date: new Date("2026-05-15T00:00:00Z"),
    query: "kw",
    page: "/p",
    country: "fra",
    device: "DESKTOP",
    searchType: "web",
    impressions: 100,
    clicks: 10,
    position: 3,
    ctr: 0.1,
  };
  await h.prisma.gscDaily.create({ data: base });
  await assert.rejects(
    () => h.prisma.gscDaily.create({ data: base }),
    (err: unknown) => (err as { code?: string }).code === "P2002",
    "un doublon sur les 7 dimensions doit lever P2002",
  );
  // Mais une row qui diffère sur UNE dimension (device) passe.
  await h.prisma.gscDaily.create({ data: { ...base, device: "MOBILE" } });
  assert.equal(await dailyCount(prop.id), 2);
});

// ─── 3. Backoff sur 429 / 5xx ───────────────────────────────────────────────

test("syncProperty: un 429 transitoire est retried puis le sync réussit", async () => {
  const { prop } = await seedVerifiedProperty();
  const rows: GscRawRow[] = [
    {
      keys: ["2026-05-15", "kw", "/p", "fra", "DESKTOP"],
      clicks: 5,
      impressions: 50,
      ctr: 0.1,
      position: 4,
    },
  ];
  // Premier appel 429, second appel 200 → le backoff interne doit retry.
  const mock = mockGscSequence([429, 200], rows);

  const result = await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mock.fetch,
    now: () => FIXED_NOW,
  });

  assert.deepEqual(result.errors, [], "le 429 doit être absorbé par le retry");
  assert.equal(result.upserted, 1);
  assert.ok(mock.calls() >= 2, "le mock a été rappelé après le 429");
  assert.equal(await dailyCount(prop.id), 1);
});

test("syncProperty: un 500 transitoire est retried puis le sync réussit", async () => {
  const { prop } = await seedVerifiedProperty();
  const rows: GscRawRow[] = [
    {
      keys: ["2026-05-15", "kw", "/p", "fra", "DESKTOP"],
      clicks: 3,
      impressions: 30,
      ctr: 0.1,
      position: 7,
    },
  ];
  const mock = mockGscSequence([500, 200], rows);
  const result = await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mock.fetch,
    now: () => FIXED_NOW,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.upserted, 1);
});

test("syncProperty: un 5xx persistant (3 retries épuisés) → erreur capturée, process stable", async () => {
  const { prop } = await seedVerifiedProperty();
  // 4 appels 503 : les 3 retries internes sont épuisés → GscApiError.
  const mock = mockGscSequence([503, 503, 503, 503], []);
  const result = await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mock.fetch,
    now: () => FIXED_NOW,
  });
  // L'erreur est capturée dans result.errors (pas un throw qui tue le sync).
  assert.equal(result.errors.length, 1);
  assert.ok(
    result.errors[0].includes("503"),
    `l'erreur doit mentionner le statut : ${result.errors[0]}`,
  );
  assert.equal(result.upserted, 0);
  // Aucune row écrite, mais lastSyncAt est quand même posé (sync tenté).
  assert.equal(await dailyCount(prop.id), 0);
});

test("syncProperty: un 4xx non-retryable (403) → erreur immédiate dans result.errors", async () => {
  const { prop } = await seedVerifiedProperty();
  const mock = mockGscSequence([403], []);
  const result = await syncProperty(h.prisma, prop.id, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mock.fetch,
    now: () => FIXED_NOW,
  });
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes("403"));
  // Un 403 ne doit PAS être retried (un seul appel).
  assert.equal(mock.calls(), 1, "un 403 ne doit pas déclencher de retry");
});

// ─── 4. Garde-fous sync sur l'état de la property ───────────────────────────

test("syncProperty: une property encore __pending__ → erreur explicite", async () => {
  const tenant = await mkTenant();
  const prop = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: "__pending__",
      type: "SITE",
      ownershipState: "pending",
      oauthAccount: encryptedValidToken(),
    },
  });
  await assert.rejects(
    () =>
      syncProperty(h.prisma, prop.id, {
        oauthConfig: OAUTH_CFG,
        fetchImpl: mockGscOk([]),
        now: () => FIXED_NOW,
      }),
    /property_pending_setup/,
  );
});

test("syncProperty: gscPropertyId inconnu → erreur property_not_found", async () => {
  await assert.rejects(
    () =>
      syncProperty(h.prisma, "gsc_does_not_exist", {
        oauthConfig: OAUTH_CFG,
        fetchImpl: mockGscOk([]),
        now: () => FIXED_NOW,
      }),
    /property_not_found/,
  );
});

// ─── 5. syncAllVerified : ne sync QUE les properties verified ────────────────

test("syncAllVerified: traite les properties verified, ignore les pending", async () => {
  // `syncAllVerified` balaie TOUTES les properties verified de la base. Comme
  // d'autres fichiers d'intégration tournent en parallèle sur le même Postgres,
  // on n'assert PAS `results.length === N` (chiffre non déterministe) : on
  // vérifie que NOTRE property verified EST dans les résultats et que NOTRE
  // property pending N'Y EST PAS.
  const { prop: verified, tenant: tVerified } = await seedVerifiedProperty(
    `https://verified-${Date.now()}.example/`,
  );

  const tenant2 = await mkTenant("t2");
  const pending = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant2.id,
      siteUrl: `https://pending-${Date.now()}.example/`,
      type: "SITE",
      ownershipState: "pending",
      oauthAccount: encryptedValidToken(),
    },
  });

  const rows: GscRawRow[] = [
    {
      keys: ["2026-05-15", "kw", "/p", "fra", "DESKTOP"],
      clicks: 1,
      impressions: 10,
      ctr: 0.1,
      position: 1,
    },
  ];
  const results = await syncAllVerified(h.prisma, {
    oauthConfig: OAUTH_CFG,
    fetchImpl: mockGscOk(rows),
    now: () => FIXED_NOW,
  });

  const ids = results.map((r) => r.gscPropertyId);
  assert.ok(
    ids.includes(verified.id),
    "la property verified doit être syncée par syncAllVerified",
  );
  assert.ok(
    !ids.includes(pending.id),
    "la property pending NE doit PAS être syncée",
  );
  // Notre property verified a bien reçu sa row (compte scopé).
  assert.equal(await dailyCount(verified.id), 1);
  // La pending n'a aucune data.
  assert.equal(await dailyCount(pending.id), 0);
  // tVerified n'est utilisé que pour fixer la portée du seed.
  assert.ok(tVerified.id);
});
