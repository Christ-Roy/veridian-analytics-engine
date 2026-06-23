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
