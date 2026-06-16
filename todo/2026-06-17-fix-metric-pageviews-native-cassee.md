# Métrique native `pageviews` cassée (countIf(name) — colonne inexistante)

> **Sévérité** : 🟡 P2 — bug latent du moteur natif analytics
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17 (découvert pendant le sprint decommission Lot B)

## Constat

`api/src/analytics/constants/metrics.ts` définit la métrique `pageviews` avec
`sql: "countIf(name = 'screen_view')"` et le commentaire "aggregated from
sessions table". MAIS la colonne `name` n'existe dans AUCUNE table analytique
(`sessions`, `pages`, `goals`) — elle est dans `events`. Donc toute query
`metrics:['pageviews']` plante en ClickHouse :
`Unknown expression or function identifier 'name' in scope`.

Révélé par le test e2e `api/test/admin-platform.e2e-spec.ts` (nouvel endpoint
M2M `analytics.query`) contre le VRAI ClickHouse — les mocks unitaires ne
l'attrapaient pas.

## Contournement appliqué (Lot B, commit 7da9f81)

Le bridge utilise désormais la métrique **`page_count`** (sur la table `pages`)
= la vraie métrique pageviews câblée dans le query-builder natif. Le bridge ne
touche PAS `metrics.ts` (métrique partagée avec la console → risque).

## À faire (ce ticket)

1. Vérifier si la métrique `pageviews` est appelée ailleurs (console native ?
   dashboards ?) — si oui, elle est cassée là aussi (ou jamais appelée sur ces
   tables).
2. Soit corriger le SQL de `pageviews` (bonne colonne/table), soit la retirer/
   aliaser vers `page_count` si redondante.
3. Tester contre vrai ClickHouse (pas mocks).

## Preuve "bug jamais déclenché en prod" (vérifié 2026-06-17)

La console native n'appelle JAMAIS la métrique `pageviews` : elle compte les
visites via la table `sessions` (label UI "Visites uniques",
`console/.../DimensionTableWidget.tsx:18`). La métrique cassée `pageviews`
(metrics.ts:55-57) n'était donc jamais sur le chemin d'exécution → bug latent
pur, révélé uniquement par le nouvel endpoint M2M `analytics.query` (Lot B).
Conséquence : corriger/retirer cette métrique est SANS risque pour la console
(elle ne l'utilise pas). Fix le plus propre = retirer la métrique morte ou
l'aliaser vers `page_count`.
