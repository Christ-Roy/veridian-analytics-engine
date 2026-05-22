#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 * run-integration.mjs — runner SÉQUENTIEL + ISOLÉ des tests d'intégration
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── Deux problèmes que ce runner résout ────────────────────────────────────
 *
 * 1. PARALLÉLISME DES FICHIERS — `node --test 'glob'` exécute les fichiers de
 *    test en parallèle (un process par fichier). Or tous les
 *    `*.integration.test.ts` partagent UNE base Postgres et le harness T1 fait
 *    un `TRUNCATE ... CASCADE` GLOBAL dans `beforeEach`. Deux fichiers en
 *    parallèle se piétinent → 401 / P2002 aléatoires. `--test-concurrency=1`
 *    s'est révélé insuffisant (flaky sur node 22). Ici : un process node par
 *    fichier, lancés STRICTEMENT l'un après l'autre.
 *
 * 2. COLLISION INTER-INVOCATIONS — plusieurs suites (agents T2/T3/T4/T5, ou
 *    plusieurs `npm run test:integration` sur la même machine) tapant la même
 *    base partagée se truncatent mutuellement. Solution : chaque invocation
 *    crée sa PROPRE base Postgres jetable (`<db>_run_<pid>_<ts>`), y pointe le
 *    harness via `BRIDGE_TEST_DATABASE_URL`, et la `DROP` à la fin.
 *    En CI le service Postgres est déjà dédié au job — l'isolation par base
 *    reste correcte et sans coût (la création d'une base vide est instantanée).
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/run-integration.mjs spec   # reporter lisible (local)
 *   node scripts/run-integration.mjs tap    # reporter TAP (CI)
 *
 * Variables lues :
 *   BRIDGE_TEST_DATABASE_URL  base Postgres "template" (host/user/pwd). Le
 *                             runner en dérive une base jetable. Défaut :
 *                             compose/test.yml (port 55432).
 *   KEEP_TEST_DB=1            ne DROP pas la base jetable (debug).
 *
 * Exit code 1 si un fichier a un test rouge.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reporter = process.argv[2] === "tap" ? "tap" : "spec";

const BRIDGE_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const TESTS_ROOT = join(BRIDGE_ROOT, "tests", "integration");
const SCHEMA_PATH = join(BRIDGE_ROOT, "prisma", "schema.prisma");

const DEFAULT_TEMPLATE_URL =
  "postgresql://bridge_test:bridge_test_pwd@127.0.0.1:55432/veridian_bridge_test";

/** Découvre récursivement tous les fichiers `*.integration.test.ts`. */
function findIntegrationTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findIntegrationTests(full));
    else if (entry.name.endsWith(".integration.test.ts")) out.push(full);
  }
  return out;
}

/**
 * Dérive une URL de base jetable depuis l'URL template. Garde host/port/
 * credentials, remplace juste le nom de la base par un nom unique au run.
 */
function deriveDisposableDbUrl(templateUrl) {
  const u = new URL(templateUrl);
  const base = u.pathname.replace(/^\//, "") || "veridian_bridge_test";
  const unique = `${base}_run_${process.pid}_${Date.now().toString(36)}`;
  const disposable = new URL(templateUrl);
  disposable.pathname = `/${unique}`;
  return { disposable: disposable.toString(), dbName: unique, adminUrl: u };
}

/** Exécute une commande psql sur la base `postgres` (admin) du serveur. */
function psqlAdmin(adminUrl, sql) {
  const conn = new URL(adminUrl.toString());
  conn.pathname = "/postgres"; // base admin toujours présente
  return spawnSync(
    "psql",
    [conn.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
}

const templateUrl = process.env.BRIDGE_TEST_DATABASE_URL ?? DEFAULT_TEMPLATE_URL;
const { disposable, dbName, adminUrl } = deriveDisposableDbUrl(templateUrl);

// ─── Création de la base jetable ────────────────────────────────────────────
let isolated = false;
const createRes = psqlAdmin(adminUrl, `CREATE DATABASE "${dbName}"`);
if (createRes.status === 0) {
  isolated = true;
  console.log(`run-integration: base jetable isolée → ${dbName}`);
} else {
  // psql absent ou serveur inaccessible en admin : on retombe sur la base
  // template partagée (comportement historique). Toujours sérialisé.
  console.warn(
    `run-integration: pas de base jetable (psql/admin indisponible) — ` +
      `fallback sur la base partagée. ${(createRes.stderr || "").trim()}`,
  );
}

const databaseUrl = isolated ? disposable : templateUrl;

function dropDisposableDb() {
  if (!isolated || process.env.KEEP_TEST_DB === "1") {
    if (isolated) console.log(`run-integration: KEEP_TEST_DB=1 — base ${dbName} conservée`);
    return;
  }
  const drop = psqlAdmin(
    adminUrl,
    `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
  );
  if (drop.status !== 0) {
    // Pas bloquant — base jetable, sera nettoyée au prochain `down -v`.
    console.warn(`run-integration: DROP DATABASE ${dbName} a échoué (non bloquant)`);
  }
}

// ─── Migrations Prisma sur la base de test ──────────────────────────────────
if (isolated) {
  const migrate = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--schema", SCHEMA_PATH],
    {
      cwd: BRIDGE_ROOT,
      stdio: "inherit",
      env: { ...process.env, BRIDGE_DATABASE_URL: databaseUrl },
    },
  );
  if (migrate.status !== 0) {
    dropDisposableDb();
    console.error("run-integration: migrate deploy a échoué sur la base jetable");
    process.exit(1);
  }
}

// ─── Exécution séquentielle des fichiers ────────────────────────────────────
const files = findIntegrationTests(TESTS_ROOT).sort();
if (files.length === 0) {
  dropDisposableDb();
  console.error("run-integration: aucun fichier *.integration.test.ts trouvé");
  process.exit(1);
}

console.log(
  `run-integration: ${files.length} fichier(s) — exécution séquentielle\n`,
);

let failed = 0;
for (const file of files) {
  const rel = file.slice(BRIDGE_ROOT.length + 1);
  console.log(`── ${rel} ──`);
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", `--test-reporter=${reporter}`, file],
    {
      cwd: BRIDGE_ROOT,
      stdio: "inherit",
      // Le harness lit BRIDGE_TEST_DATABASE_URL → on lui passe la base isolée.
      env: { ...process.env, BRIDGE_TEST_DATABASE_URL: databaseUrl },
    },
  );
  if (res.status !== 0) {
    failed += 1;
    console.error(`✖ ÉCHEC : ${rel}`);
  }
  console.log("");
}

// ─── Teardown ───────────────────────────────────────────────────────────────
dropDisposableDb();

if (failed > 0) {
  console.error(`run-integration: ${failed} fichier(s) en échec`);
  process.exit(1);
}
console.log(`run-integration: ${files.length} fichier(s) OK`);
