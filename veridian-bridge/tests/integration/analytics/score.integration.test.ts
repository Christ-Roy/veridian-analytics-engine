/**
 * ════════════════════════════════════════════════════════════════════════════
 * score.integration.test.ts — GET /api/admin/tenant/:wsId/score contre une VRAIE staminads
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Couvre l'endpoint Score Veridian (`src/app.ts`) + la lib `src/score.ts`
 * (`buildCountsFromStaminadsRows`, `computeScore`).
 *
 * "VRAIE staminads" = `RealStaminads` (cf `_real-staminads.ts`) : un serveur
 * HTTP qui sert `/api/analytics.query` en exécutant une RÉELLE requête
 * d'agrégation sur le ClickHouse de test. Les pageviews ne sont pas codés en
 * dur — ils sont COMPTÉS par ClickHouse à partir de lignes d'événements
 * vraiment insérées.
 *
 * Ce que ça prouve, qu'un mock ne prouverait pas :
 *   - le bridge émet une requête HTTP qu'une staminads sait traiter ;
 *   - le bridge parse la réponse réelle et la transforme en score correct ;
 *   - X pageviews seedés → ClickHouse compte X → le bridge calcule le bon
 *     score + label.
 *
 * Le harness boote AUSSI un vrai Postgres (le bridge en a besoin pour exister)
 * mais l'endpoint score ne touche pas Postgres — il ne lit que staminads.
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealStaminads,
  TEST_ADMIN_KEY,
  type StaminadsBridgeHarness,
} from "../_harness/index.js";
import { RealStaminads } from "./_real-staminads.js";

let staminads: RealStaminads;
let h: StaminadsBridgeHarness;

before(async () => {
  // 1. Démarre la VRAIE staminads (serveur HTTP + base ClickHouse dédiée).
  staminads = new RealStaminads();
  const staminadsUrl = await staminads.start();
  // 2. Boote le bridge pointé sur cette staminads réelle (+ vrai Postgres).
  h = await bootBridgeWithRealStaminads({ staminadsUrl });
});

after(async () => {
  await h.close();
  await staminads.stop();
});

/** workspaceId staminads unique par test (isolation cross-test/fichier). */
function uniqueWorkspaceId(label: string): string {
  return `ws_score_${label}_${randomUUID().replace(/-/g, "")}`;
}

function getScore(workspaceId: string, withAuth = true) {
  return fetch(`${h.url}/api/admin/tenant/${workspaceId}/score`, {
    headers: withAuth ? { Authorization: `Bearer ${TEST_ADMIN_KEY}` } : {},
  });
}

interface ScoreResponse {
  workspaceId: string;
  score: number;
  label: string;
  services: { active: string[]; inactive: string[] };
}

// ─── 1. Workspace avec pageviews → score calculé contre la VRAIE staminads ───

test("score: workspace avec 1500 pageviews → score 30, 'À améliorer'", async () => {
  const ws = uniqueWorkspaceId("pv1500");
  // 1500 événements screen_view RÉELLEMENT insérés en ClickHouse.
  await staminads.seedPageviews(ws, 1500);

  const res = await getScore(ws);
  assert.equal(res.status, 200);
  const body = (await res.json()) as ScoreResponse;

  assert.equal(body.workspaceId, ws);
  // pageviews > 0 → poids 30. Pas de goals → forms inactif.
  // Le compte 1500 vient de l'agrégation ClickHouse, pas d'un mock.
  assert.equal(body.score, 30, "30 points pour pageviews actif");
  assert.equal(body.label, "À améliorer");
  assert.deepEqual(body.services.active, ["pageviews"]);
  assert.deepEqual(body.services.inactive, [
    "forms",
    "calls",
    "gsc",
    "ads",
    "pagespeed",
  ]);
});

// ─── 2. Workspace avec pageviews + goals → score 50 ─────────────────────────

test("score: workspace avec pageviews + goals → score 50, 'Bon'", async () => {
  const ws = uniqueWorkspaceId("pvgoals");
  // 800 pageviews + 5 goals, tous insérés réellement en ClickHouse.
  await staminads.seedPageviews(ws, 800);
  await staminads.seedEvents(
    Array.from({ length: 5 }, () => ({ workspaceId: ws, name: "goal" })),
  );

  const res = await getScore(ws);
  assert.equal(res.status, 200);
  const body = (await res.json()) as ScoreResponse;

  // pageviews(30) + forms(20, via proxy goals) = 50 → "Bon".
  assert.equal(body.score, 50);
  assert.equal(body.label, "Bon");
  assert.deepEqual(body.services.active, ["pageviews", "forms"]);
});

// ─── 3. Workspace VIDE → score 0, 'À démarrer' (contre la vraie staminads) ───

test("score: workspace vide → score 0, 'À démarrer'", async () => {
  const ws = uniqueWorkspaceId("empty");
  // Aucun event seedé : ClickHouse comptera 0 pour ce workspace.

  const res = await getScore(ws);
  assert.equal(res.status, 200);
  const body = (await res.json()) as ScoreResponse;

  assert.equal(body.score, 0, "aucun pageview réel → score 0");
  assert.equal(body.label, "À démarrer");
  assert.deepEqual(body.services.active, []);
  assert.deepEqual(body.services.inactive, [
    "pageviews",
    "forms",
    "calls",
    "gsc",
    "ads",
    "pagespeed",
  ]);
});

// ─── 4. L'agrégation est exacte : N pageviews seedés → N comptés ─────────────

test("score: le compteur reflète exactement les pageviews seedés (agrégation CH réelle)", async () => {
  // Deux workspaces distincts, volumes différents, dans la même staminads :
  // prouve que ClickHouse filtre bien par workspace_id.
  const wsBig = uniqueWorkspaceId("big");
  const wsSmall = uniqueWorkspaceId("small");
  await staminads.seedPageviews(wsBig, 42);
  await staminads.seedPageviews(wsSmall, 1);

  const big = (await (await getScore(wsBig)).json()) as ScoreResponse;
  const small = (await (await getScore(wsSmall)).json()) as ScoreResponse;

  // Les deux ont des pageviews > 0 → tous deux score 30, pageviews actif.
  // Le point clé : aucun ne "voit" les events de l'autre (filtre CH par ws).
  assert.equal(big.score, 30);
  assert.deepEqual(big.services.active, ["pageviews"]);
  assert.equal(small.score, 30);
  assert.deepEqual(small.services.active, ["pageviews"]);

  // Un 3e workspace jamais seedé reste à 0 malgré la présence des deux autres.
  const wsGhost = uniqueWorkspaceId("ghost");
  const ghost = (await (await getScore(wsGhost)).json()) as ScoreResponse;
  assert.equal(ghost.score, 0, "workspace non seedé → 0 (pas de fuite CH)");
});

// ─── 5. Auth : sans Bearer → 401 ────────────────────────────────────────────

test("score: requête sans Bearer → 401 missing_bearer", async () => {
  const ws = uniqueWorkspaceId("noauth");
  await staminads.seedPageviews(ws, 100);
  const res = await getScore(ws, false);
  assert.equal(res.status, 401);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "missing_bearer",
  );
});

// ─── 6. Auth : mauvaise clé → 403 ───────────────────────────────────────────

test("score: mauvaise clé Bearer → 403 invalid_admin_key", async () => {
  const ws = uniqueWorkspaceId("badkey");
  const res = await fetch(`${h.url}/api/admin/tenant/${ws}/score`, {
    headers: { Authorization: "Bearer wrong-key-not-the-admin-one" },
  });
  assert.equal(res.status, 403);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "invalid_admin_key",
  );
});
