# workspaces.status renvoie sessions_30d/visitors_30d=0 alors que les données existent (338 sessions)

> **Sévérité** : 🟡 P1 (régression, mais données intactes — affichage status seulement)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Symptôme (vérifié PROD post-promo vague 2)
`POST /api/admin/platform/workspaces.status {workspace_id: vrd_veridian_site_prod}`
renvoie `tracking: {active:false, sessions_30d:0, visitors_30d:0, live:false}`.
MAIS la query directe `analytics.query metrics:[sessions]` sur 30j glissants (même
fenêtre) renvoie **338 sessions**. Donc les DONNÉES sont intactes (zéro perte
d'ingestion), c'est le CALCUL du status consolidé qui régresse à 0.
Avant la vague 2, le status renvoyait correctement sessions_30d=332.

Bonus suspect : `analytics.query` all-time (start 2020 / end 2030) renvoie `data: None`
(devrait renvoyer un nombre) → la borne de date très large casse peut-être la query
(à vérifier séparément — possible que ce soit lié).

## Cause probable
Le chantier attribution (channel à l'ingestion, `session-payload.handler`) ou
customisation a touché `measureTracking`/`probeTracking` dans `admin-platform.service.ts`
(l'agent qualité avait signalé avoir failli écraser `probeTracking` lors d'une collision
working-tree). La fenêtre de date du status (30j) est calculée différemment de
`analytics.query` → tombe à 0. Régression introduite par la vague 2 (2026-06-23).

## Localisation
- `api/src/admin-platform/admin-platform.service.ts` — `measureTracking`/`probeTracking`
  (calcul sessions_30d/visitors_30d du status)
- comparer avec la résolution de dateRange de `analytics.service.ts` (qui marche)

## Correctif
Aligner le calcul de la fenêtre 30j du status sur celui d'`analytics.query` (qui
renvoie 338). Test : status sessions_30d doit matcher analytics.query 30j. Vérifier
aussi pourquoi all-time renvoie None (borne 2020-2030).

## Impact
Status M2M trompeur (un workspace actif paraît mort). Les dashboards clients ne sont
PAS affectés (ils lisent les vraies queries). Mais l'IA/Hub qui appelle status pour
juger l'état d'un tenant aura un faux négatif. À corriger vite (P1).

## Résolution — 2026-06-23 (commit 9f1d707)
**Cause RÉELLE** (≠ hypothèse fenêtre de date du ticket) : collision working-tree
entre `fd91e83` (ajoute la métrique `unique_visitors`) et `3fe98f8`
(`fix(analytics): pageviews metric sums pageview_count`). `3fe98f8` a réécrit le
bloc `pageviews` de `api/src/analytics/constants/metrics.ts` à partir d'un arbre
périmé d'AVANT `fd91e83` → a **silencieusement supprimé `unique_visitors`** du
registre `METRICS`.

`probeTracking` (admin-platform.service.ts:472) interroge toujours
`unique_visitors` via `countMetric` → `AnalyticsService.query()` lève
`BadRequestException: Unknown metric: unique_visitors` → le `Promise.all` rejette
→ le `try/catch` dégrade vers `safe` (tout à zéro). D'où `sessions_30d=0`,
`visitors_30d=0`, `active=false` alors que les données sont intactes (332/338).

La **résolution de date (preset `previous_30_days`) marche parfaitement** : un
appel direct `analytics.query {preset:previous_30_days}` renvoie 332. Le bug
n'était PAS dans `date-utils.ts`/`query-builder.ts`/`analytics.service.ts`.

Le **all-time `data: None`** du ticket = MÊME cause : interroger `unique_visitors`
sur n'importe quelle plage renvoie `400 Unknown metric` (vérifié prod). `sessions`
seul sur {2020..2030} renvoie 338 sans souci. Un seul bug, pas deux.

**Pourquoi les tests unitaires ne l'ont pas vu** : le spec status mocke
`AnalyticsService.query` → il ne touche jamais le vrai registre `METRICS`.

**Fix** : restauration de `unique_visitors` (`uniqExact(visitor_id)`) +
`metrics.spec.ts` qui épingle le contrat des métriques du status-probe (échoue en
CI si une future collision en supprime une). Vérifié prod (332 sessions réelles),
testé sur dev-pub (54 tests verts + tsc OK).
