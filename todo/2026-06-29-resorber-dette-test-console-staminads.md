# Résorber la dette de test console (code hérité staminads)

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-29
> **Contexte** : suite de l'incident prod 2026-06-29 (crash `undefined.toFixed()`).

## Contexte

L'incident a révélé que **tout le code console hérité staminads** (`src/lib`,
`src/components`, `src/hooks`) tournait en prod **sans aucun test** : vitest
était scopé strictement sur `src/veridian/**`, et le test-mapping pre-push
SKIPait la console. Un crash y a planté tous les workspaces sans gate.

Corrigé en b95e022 (élargissement vitest + mapping). Mais **85 fichiers
legacy** sont en dette déclarée dans `tests-pending.txt` (tolérés par le
mapping pour ne pas bloquer les pushs, mais NON testés).

## Demande

Résorber progressivement `tests-pending.txt` : pour chaque fichier listé,
écrire un test colocalisé `<dir>/__tests__/<base>.test.tsx` puis le retirer
de la liste. Prioriser :

1. **Code de formatage / transformation de data** (le plus risqué — c'est
   exactement la classe de bug de l'incident) :
   - `console/src/lib/dimension-utils.ts` (toMetricNumber, transformToDimensionData)
   - `console/src/lib/csv-utils.ts`, `console/src/lib/explore-utils.ts` (partiel : fait)
   - `console/src/components/dashboard/custom-widget.ts` + `CustomWidget.tsx`
2. **Widgets dashboard montés** (rendu avec data réelle) :
   - `CountryMapView`, `MetricSummary`, `DashboardGrid`, `ComparisonPicker`
3. **Hooks d'I/O** : `useDimensionQuery`, `useBreakdown`, etc.

Le reste (Assistant, composants purement présentationnels) = priorité basse.

## Note process

`tests-pending.txt` ne doit JAMAIS grossir : tout NOUVEAU fichier console
critique doit naître avec son test (le mapping l'exige déjà). La liste ne fait
que **décroître**. Quand elle est vide → retirer le mécanisme pending pour la
console et durcir le mapping en dur.

## Critère

`tests-pending.txt` réduit à 0 ligne (hors commentaires) à terme.
