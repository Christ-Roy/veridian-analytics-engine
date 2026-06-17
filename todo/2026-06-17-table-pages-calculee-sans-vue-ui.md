# Table `pages` entièrement calculée mais aucune vue « Top pages » dans la console

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics (engine)
> **Créé** : 2026-06-17
> **Axe audit** : KPI/Dashboard — parité backend↔UI

## Constat (trou de parité prouvé par le code)

Le backend calcule en continu une table `pages` complète (analytics par
page : quelles pages sont vues, combien de fois, temps passé, scroll, entrée/
sortie), mais **aucune vue de la console ne l'affiche**. C'est de l'analytics
web de base (« quelles sont mes pages les plus consultées ? ») totalement
absente de l'UI.

Backend (calcul) :

- `api/src/database/schemas.ts:557` → `CREATE TABLE pages` (path, duration,
  max_scroll, is_landing, is_exit, page_number…).
- `api/src/database/schemas.ts:596` → `pages_mv` materialized view qui peuple
  `pages` à chaque event → **table vivante, peuplée en continu**.
- `api/src/analytics/constants/tables.ts` → `pages` est une table analytique
  de première classe (`TABLE_CONFIGS.pages`, FINAL/ReplacingMergeTree).
- `api/src/analytics/constants/metrics.ts:74-116` → **7 métriques `pages`**
  définies : `page_count`, `unique_pages`, `page_duration`, `page_scroll`,
  `landing_page_count`, `exit_page_count`, `exit_rate`.
- `api/src/analytics/constants/dimensions.ts:126` → dimension `page_path`
  (`column: 'path'`, table `pages`) + `page_number`, `is_landing_page`,
  `is_exit_page`, `page_entry_type`.

UI (affichage) — RIEN :

- `grep "table: 'pages'"` sur `console/src/` → **0 résultat**. Aucune requête
  console n'interroge la table `pages`.
- `console/src/components/dashboard/DashboardGrid.tsx` a bien un onglet
  « Pages d'entrée » (`landing_path`, ligne 230) et « Sorties » (`exit_path`,
  ligne 237) — mais ceux-ci viennent de la table **`sessions`**, PAS de la
  table `pages`. Il n'existe AUCUN onglet « Pages les plus vues » / « Temps
  par page » / « Scroll par page ».
- Les 7 métriques `pages` ont **0 référence en dur** dans `console/src/`
  (vérifié par grep par métrique).

## Pourquoi ce n'est PAS bloqué par la règle « on ne refait pas staminads »

Une vue « Top pages » est exactement de l'analytics staminads vanille — pas
une feature Veridian custom. Le moteur (staminads forké) a la table, les
métriques et la dimension prêtes ; il manque uniquement le câblage UI. Soit
staminads upstream l'avait et le port l'a perdu, soit elle n'a jamais été
branchée. Dans les deux cas c'est un trou : un client qui paie un analytics
sans savoir quelles pages cartonnent, c'est un manque criant.

## Impact

- Donnée calculée + stockée en continu (coût CH) mais 100 % invisible.
- Manque une vue analytics standard que tout concurrent (Plausible, GA, …)
  affiche en premier écran. Argument commercial faible à la démo.

## Demande précise (voie propre, conforme à la vision — natif, pas de page Veridian)

1. **UI** — ajouter un onglet de breakdown « Pages » dans le `DashboardGrid`
   natif (`console/src/components/dashboard/DashboardGrid.tsx`, à côté de
   « Pages d'entrée » / « Sorties »), dimension `page_path`, table `pages`,
   métriques `page_count` + `page_duration` + `page_scroll` (+ option
   `exit_rate`). Réutilise le composant `DimensionTab` existant — zéro
   nouvelle route, zéro page custom : c'est un onglet de plus dans la grille
   staminads native, donc strictement conforme à la règle UI 2026-05-23.

2. **Backend** — rien à créer : métriques + dimension + table déjà en place.
   Vérifier juste que `analytics.query` sur `table: 'pages'` +
   `dimensions: ['page_path']` + `metrics: ['page_count','page_duration','page_scroll']`
   répond correctement (test contractuel si besoin).

## Note connexe

`analyticsMetricsQueryOptions` (`console/src/lib/queries.ts:16`) qui charge
`analytics.metrics` n'est **importé par aucun composant `.tsx`** → l'endpoint
`analytics.metrics` est mort côté UI, et il n'existe pas de sélecteur de
métrique dynamique dans Explore (set figé `['sessions','median_duration',
'bounce_rate','median_scroll']`, cf `explore.tsx:168`). Donc même via Explore,
un utilisateur ne peut pas atteindre les métriques `pages`. À garder en tête
pour ne pas croire qu'« Explore couvre déjà tout ».
