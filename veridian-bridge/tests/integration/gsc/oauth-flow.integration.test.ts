/**
 * ════════════════════════════════════════════════════════════════════════════
 * oauth-flow.integration.test.ts — flow OAuth GSC contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T4. Couvre `src/gsc/oauth.ts` + `src/gsc/index.ts` (oauthCallback) +
 * les routes `/api/admin/gsc/oauth-begin` et `/api/admin/gsc/oauth-callback`.
 *
 * Ce que ça PROUVE (vs le test FakePrisma `gsc-end-to-end.test.ts`) :
 *
 *   - L'échange de code OAuth est mocké au niveau HTTP (le réseau Google n'est
 *     jamais touché), MAIS la persistance des tokens va dans un vrai Postgres :
 *     la row `GscProperty.oauthAccount` est écrite RÉELLEMENT puis relue avec
 *     un second client Prisma.
 *   - Le blob stocké est du chiffré AES-256-GCM : on lit directement la colonne
 *     `oauthAccount` en SQL et on vérifie qu'AUCUN secret (access_token /
 *     refresh_token) n'apparaît en clair. Le clear-text n'existe que si on
 *     déchiffre avec la clé.
 *   - Un `state` HMAC falsifié est refusé AVANT toute écriture DB.
 *
 * Le harness applique `prisma migrate deploy` au boot — si la colonne
 * `oauthAccount Json?` n'existait pas, ce fichier serait rouge.
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
  TEST_ADMIN_KEY,
  TEST_ENCRYPTION_KEY,
  type BridgeHarness,
} from "../_harness/index.js";
import {
  buildState,
  decryptTokens,
  type EncryptedBlob,
  type OauthTokens,
} from "../../../src/gsc/index.js";

// ─── Mock Google : token endpoint uniquement (aucun réseau réel) ────────────

/**
 * Renvoie un `fetch` mocké qui répond à l'échange `authorization_code`
 * (et au `refresh_token`). Tout le reste → 404. Les tokens retournés sont
 * fixes et reconnaissables : on les retrouve plus tard via déchiffrement.
 */
function makeMockGoogleToken(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ATOKEN_secret_value_xyz",
          refresh_token: "RTOKEN_secret_value_abc",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/webmasters.readonly",
          token_type: "Bearer",
        }),
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

/** Nombre de GscProperty rattachées à un tenant précis (compte SCOPÉ). */
function propCount(tenantId: string): Promise<number> {
  return h.prisma.gscProperty.count({ where: { tenantId } });
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

// ─── 1. oauth-begin : URL Google + state HMAC anti-CSRF ─────────────────────

test("oauth-begin: génère une URL Google consent + un state signé HMAC", async () => {
  const tenant = await mkTenant("gsc-begin");

  const res = await fetch(
    `${h.url}/api/admin/gsc/oauth-begin?tenantId=${tenant.id}`,
    { method: "POST", headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    url: string;
    state: string;
    tenantId: string;
  };

  // L'URL pointe sur le consent screen Google et embarque les bons params.
  assert.ok(
    body.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"),
    "doit pointer sur le consent Google",
  );
  const u = new URL(body.url);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(
    u.searchParams.get("scope"),
    "https://www.googleapis.com/auth/webmasters.readonly",
  );

  // Le state est `<tenantId>.<hmac>` : il porte l'id ET sa signature.
  assert.equal(body.tenantId, tenant.id);
  assert.ok(body.state.startsWith(`${tenant.id}.`));
  assert.equal(
    body.state,
    u.searchParams.get("state"),
    "le state de l'URL et du body doivent être identiques",
  );

  // Le state recalculé avec la bonne clé doit matcher (anti-CSRF).
  const expected = buildState(tenant.id, TEST_ENCRYPTION_KEY);
  assert.equal(body.state, expected, "state HMAC reproductible avec la clé");
});

test("oauth-begin: 404 si le tenant n'existe pas en DB", async () => {
  // Aucun seed → la route fait un vrai SELECT qui ne trouve rien.
  const res = await fetch(
    `${h.url}/api/admin/gsc/oauth-begin?tenantId=tenant_inexistant`,
    { method: "POST", headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "tenant_not_found");
});

test("oauth-begin: 401 sans Bearer admin", async () => {
  const tenant = await mkTenant();
  const res = await fetch(
    `${h.url}/api/admin/gsc/oauth-begin?tenantId=${tenant.id}`,
    { method: "POST" },
  );
  assert.equal(res.status, 401);
});

// ─── 2. oauth-callback : tokens RÉELLEMENT chiffrés en Postgres ──────────────

test("oauth-callback: persiste des tokens AES-256-GCM dans GscProperty.oauthAccount", async () => {
  // Le harness câble les routes GSC sans `fetchImpl` → le callback HTTP
  // utiliserait le vrai réseau Google. On teste donc le handler `oauthCallback`
  // de la lib directement, en injectant le mock Google. La PERSISTANCE, elle,
  // va bien dans le VRAI Postgres `h.prisma`.
  const { oauthCallback } = await import("../../../src/gsc/index.js");
  const tenant = await mkTenant("gsc-cb");
  const state = buildState(tenant.id, TEST_ENCRYPTION_KEY);

  const cfg = {
    clientId: "it-client-id",
    clientSecret: "it-client-secret",
    redirectUri: "https://bridge.test/api/admin/gsc/oauth-callback",
    encryptionKey: TEST_ENCRYPTION_KEY,
  };

  const { tenantId } = await oauthCallback(
    h.prisma,
    "FAKE_AUTH_CODE",
    state,
    cfg,
    makeMockGoogleToken(),
  );
  assert.equal(tenantId, tenant.id);

  // ─── La preuve #1 : une row GscProperty placeholder existe RÉELLEMENT ──────
  const prop = await h.prisma.gscProperty.findUnique({
    where: { tenantId_siteUrl: { tenantId: tenant.id, siteUrl: "__pending__" } },
  });
  assert.ok(prop, "une GscProperty placeholder doit être créée en DB");
  assert.equal(prop.ownershipState, "pending");
  assert.ok(prop.oauthAccount, "oauthAccount ne doit pas être null");

  // ─── La preuve #2 : le blob a la shape d'un chiffré AES-256-GCM ────────────
  const blob = prop.oauthAccount as unknown as EncryptedBlob;
  assert.equal(blob.v, 1);
  assert.ok(typeof blob.iv === "string" && /^[0-9a-f]+$/.test(blob.iv));
  assert.ok(typeof blob.tag === "string" && /^[0-9a-f]+$/.test(blob.tag));
  assert.ok(
    typeof blob.ciphertext === "string" && /^[0-9a-f]+$/.test(blob.ciphertext),
  );

  // ─── La preuve #3 : déchiffré, on retrouve les tokens du mock Google ──────
  const decrypted = decryptTokens(blob, TEST_ENCRYPTION_KEY);
  assert.equal(decrypted.access_token, "ATOKEN_secret_value_xyz");
  assert.equal(decrypted.refresh_token, "RTOKEN_secret_value_abc");
  assert.equal(
    decrypted.scope,
    "https://www.googleapis.com/auth/webmasters.readonly",
  );
  assert.ok(decrypted.expires_at > Date.now(), "expires_at dans le futur");
});

test("oauth-callback: les secrets ne sont JAMAIS stockés en clair (lecture SQL brute)", async () => {
  const { oauthCallback } = await import("../../../src/gsc/index.js");
  const tenant = await mkTenant("gsc-noclear");
  const state = buildState(tenant.id, TEST_ENCRYPTION_KEY);

  await oauthCallback(
    h.prisma,
    "FAKE_AUTH_CODE",
    state,
    {
      clientId: "it-client-id",
      clientSecret: "it-client-secret",
      redirectUri: "https://bridge.test/cb",
      encryptionKey: TEST_ENCRYPTION_KEY,
    },
    makeMockGoogleToken(),
  );

  // On lit la colonne `oauthAccount` en SQL brut, en la castant en texte.
  // Si le code stockait les tokens en clair, on les verrait ici. Avec le
  // chiffrement AES-256-GCM, le JSON ne contient que iv/tag/ciphertext.
  const rows = (await h.prisma.$queryRawUnsafe(
    `SELECT "oauthAccount"::text AS blob FROM "GscProperty" WHERE "tenantId" = $1`,
    tenant.id,
  )) as Array<{ blob: string }>;
  assert.equal(rows.length, 1);
  const rawText = rows[0].blob;

  // Les valeurs secrètes du mock ne doivent JAMAIS apparaître en clair.
  assert.ok(
    !rawText.includes("ATOKEN_secret_value_xyz"),
    "le access_token ne doit pas être en clair dans la colonne",
  );
  assert.ok(
    !rawText.includes("RTOKEN_secret_value_abc"),
    "le refresh_token ne doit pas être en clair dans la colonne",
  );
  // Le blob doit en revanche contenir les champs de chiffrement.
  assert.ok(rawText.includes("ciphertext"), "le blob contient bien un ciphertext");
  assert.ok(rawText.includes("iv"));
  assert.ok(rawText.includes("tag"));
});

test("oauth-callback: re-callback pour le même tenant → upsert idempotent (1 seule row)", async () => {
  const { oauthCallback } = await import("../../../src/gsc/index.js");
  const tenant = await mkTenant("gsc-reidem");
  const state = buildState(tenant.id, TEST_ENCRYPTION_KEY);
  const cfg = {
    clientId: "it-client-id",
    clientSecret: "it-client-secret",
    redirectUri: "https://bridge.test/cb",
    encryptionKey: TEST_ENCRYPTION_KEY,
  };

  await oauthCallback(h.prisma, "CODE_1", state, cfg, makeMockGoogleToken());
  await oauthCallback(h.prisma, "CODE_2", state, cfg, makeMockGoogleToken());

  // `persistTokensForTenant` fait un upsert sur (tenantId, "__pending__") :
  // deux callbacks ne créent qu'UNE row (vraie contrainte @@unique).
  const count = await h.prisma.gscProperty.count({
    where: { tenantId: tenant.id },
  });
  assert.equal(count, 1, "un re-callback ne doit pas dupliquer la property");
});

// ─── 3. State invalide / falsifié → rejet AVANT toute écriture DB ───────────

test("oauth-callback HTTP: state falsifié → 400, aucune row écrite", async () => {
  const tenant = await mkTenant("gsc-tamper");
  const validState = buildState(tenant.id, TEST_ENCRYPTION_KEY);
  // On remplace le tenantId dans le state mais on garde l'ancienne signature.
  const tamperedState = validState.replace(tenant.id, `${tenant.id}_evil`);

  const res = await fetch(
    `${h.url}/api/admin/gsc/oauth-callback?code=ABC&state=${encodeURIComponent(tamperedState)}`,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; message?: string };
  assert.equal(body.error, "oauth_flow_error");

  // Aucune GscProperty ne doit avoir été créée pour CE tenant : le rejet est
  // pré-écriture (compte scopé — d'autres fichiers tournent en parallèle).
  assert.equal(await propCount(tenant.id), 0);
  // Le faux tenantId du state falsifié n'a non plus rien créé.
  assert.equal(await propCount(`${tenant.id}_evil`), 0);
});

test("oauth-callback HTTP: state sans séparateur → 400 invalid_state", async () => {
  // Un state sans `.` ne parse aucun tenantId → `parseState` throw avant
  // toute écriture. Le 400 EST la preuve (pas de count global possible ici).
  const res = await fetch(
    `${h.url}/api/admin/gsc/oauth-callback?code=ABC&state=garbagewithoutdot`,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "oauth_flow_error");
});

test("oauth-callback HTTP: code ou state manquant → 400 missing_code_or_state", async () => {
  const res = await fetch(`${h.url}/api/admin/gsc/oauth-callback?code=ABC`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "missing_code_or_state");
});

test("oauth-callback: un blob écrit avec une AUTRE clé ne déchiffre pas", async () => {
  // Garantie de défense en profondeur : le chiffrement GCM authentifie.
  // On persiste un token chiffré avec la bonne clé puis on tente un déchiffrement
  // avec une clé différente → doit throw (auth tag mismatch).
  const { encryptTokens } = await import("../../../src/gsc/index.js");
  const tokens: OauthTokens = {
    access_token: "AT",
    refresh_token: "RT",
    expires_at: Date.now() + 3600_000,
    scope: "s",
    token_type: "Bearer",
  };
  const blob = encryptTokens(tokens, TEST_ENCRYPTION_KEY);
  const wrongKey = "a".repeat(64);
  assert.throws(
    () => decryptTokens(blob, wrongKey),
    "déchiffrer avec une mauvaise clé doit échouer (GCM auth tag)",
  );
});
