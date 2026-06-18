# Résidus anglais dans le natif staminads (app FR vouvoiement)

> **Sévérité** : 🟢 P2 — cohérence langue, app commercialisée en France
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-dashboard (UI-2)

## Contexte

CLAUDE.md analytics (« Langue : français par défaut ») : toute la console doit
être en français, vouvoiement, accents préservés. L'audit des widgets/vues
analytiques révèle plusieurs résidus anglais du fork staminads qui n'ont pas
été francisés. Ils dénotent dans une app vendue à des clients français. Aucun
n'est bloquant ; ce sont des chaînes UI.

## Problème 1 — `getDimensionLabel` rend du Title Case anglais

`console/src/lib/explore-utils.ts:370-390` : `getDimensionLabel` convertit le
nom de dimension snake_case → Title Case **en anglais** :

```ts
return dimensionName.split('_')
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(' ')
```

Résultat affiché partout (Explore header de dimension, sélecteurs, breakdown,
ExploreSummary « Meilleure combinaison ») :
- `phone_source` → **« Phone Source »** (attendu : « Source d'appel »)
- `phone_direction` → « Phone Direction » (attendu : « Sens d'appel »)
- `phone_status` → « Phone Status » (attendu : « Statut d'appel »)
- `referrer_domain` → « Referrer Domain » (attendu : « Domaine référent »)
- `utm_source` → « Utm Source », `landing_path` → « Landing Path », etc.

C'est le **point le plus visible** : nos dimensions VoIP s'affichent en anglais.

### Demande

Ajouter une table de libellés FR explicite et la consulter en priorité dans
`getDimensionLabel` (fallback Title Case si absent). Couvrir au minimum les
dimensions exposées dans l'UI (traffic, UTM, pages, device, geo, time +
**phone_***). Garder le fallback pour les `stm_*` custom (déjà géré).

## Problème 2 — `GRANULARITY_LABELS` en anglais

`console/src/lib/chart-utils.ts:58-64` :
```ts
export const GRANULARITY_LABELS = {
  hour: 'Hourly', day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly',
}
```
Affiché dans le `GranularitySelector` (`console/src/components/dashboard/GranularitySelector.tsx:28`),
posé en haut à droite du graphe du dashboard — **juste à côté** du
`ComparisonPicker` qui, lui, est en français (« Période précédente »). Le
contraste « Daily » / « Période précédente » sur la même barre est franchement
visible.

### Demande

Traduire : `Horaire / Journalier / Hebdomadaire / Mensuel / Annuel`.

## Problème 3 — `(empty)` non traduit (6 occurrences)

Valeurs de dimension vides affichées « (empty) » au lieu de « (vide) » :
- `console/src/components/dashboard/DimensionTableWidget.tsx:247` et `:494`
- `console/src/components/explore/ExploreTable.tsx:121` et `:289`
- `console/src/components/explore/BreakdownDrawer.tsx:46`
- `console/src/lib/csv-utils.ts:73` (export CSV)

À noter : `ExploreSummary.tsx:147` utilise déjà « (non défini) » (français) pour
le même cas → incohérence interne en plus de la langue.

### Demande

Remplacer par « (vide) » (ou « (non défini) » pour s'aligner sur
ExploreSummary — choisir UN terme et l'uniformiser). Idéalement une constante
partagée `EMPTY_VALUE_LABEL`.

## Problème 4 — Dates du graphe en anglais

`console/src/lib/chart-utils.ts` :
- `formatDateRange` (l.230-247) → légendes « Dec 21-28 », « Dec 21 - Jan 4 »
- `formatXAxisLabel` (l.154-173) → axe X « 9am », « Dec 21 », « Dec '25 »

CLAUDE.md exige le format date `dd/MM/yyyy HH:mm`. Le graphe principal du
dashboard et celui du GoalDashboardDrawer affichent donc des dates anglaises.

### Demande

Franciser via le locale dayjs (`dayjs.locale('fr')` est déjà disponible —
vérifier qu'il est chargé) : « 21 déc. », « 21–28 déc. », axe « 9h ». Tier 🟢.

## Tooltips des sélecteurs (`Type:` / `e.g.`)

Mineur, en passant : les tooltips des dimensions affichent « Type: » et
« e.g. X, Y » en anglais (`DimensionSelector.tsx:183-186`,
`BreakdownModal`/`ExploreFilterBuilder` idem). À franciser (« Type : » / « ex. »).

## Impact

UI pure, zéro backend, zéro migration. Tier 🟢 BAS. Gros gain de perception
« app française propre » pour un effort faible. Le Problème 1 (phone_*) est
celui qui sert le plus directement l'objectif « nos intégrations se fondent
dans le natif » — à prioriser.
