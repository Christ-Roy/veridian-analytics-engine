# Cohérence catégories de dimensions — Téléphonie orpheline + libellés EN

> **Sévérité** : 🟡 P1 — nos ajouts Veridian (Téléphonie) dénotent visuellement
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-dashboard (UI-2)

## Contexte

Audit de cohérence UI : « nos intégrations doivent se fondre dans le natif
staminads, sans dénoter ». Nos dimensions VoIP (`phone_source`,
`phone_direction`, `phone_status`, catégorie backend `'Téléphonie'`,
`api/src/analytics/constants/dimensions.ts:447-467`) sont exposées dans les
3 sélecteurs de dimensions de la console. Elles dénotent franchement pour
3 raisons.

## Problème 1 — La catégorie « Téléphonie » tombe en fin de liste (orpheline)

Les 3 sélecteurs trient les catégories selon un tableau `categoryOrder` codé en
dur, avec fallback alphabétique pour les catégories absentes :

- `console/src/components/explore/DimensionSelector.tsx:127`
  `['UTM', 'Traffic', 'Pages', 'Device', 'Time', 'Geo', 'Custom']`
- `console/src/components/explore/BreakdownModal.tsx:41`
  `['UTM', 'Traffic', 'Channel', 'Geo', 'Pages', 'Device', 'Time', 'Custom']`
- `console/src/components/explore/ExploreFilterBuilder.tsx` (même pattern, cf
  `filteredByCategory` + rendu ligne 512-515)

**Aucun** des 3 ne contient `Téléphonie`, ni `Goal`, ni `User`. Conséquence :
ces 3 catégories backend tombent dans la branche `aIndex === -1` →
positionnées en fin via `localeCompare`, dans un ordre arbitraire. « Téléphonie »
apparaît donc après « Custom » au lieu d'être à un rang cohérent et stable.

## Problème 2 — Les 3 `categoryOrder` divergent entre eux

Comparer les deux tableaux ci-dessus : ordre différent (`Channel` présent dans
BreakdownModal, absent de DimensionSelector ; `Geo` avant/après `Pages` selon le
fichier). Le même utilisateur voit les catégories rangées différemment selon
qu'il ouvre le sélecteur d'Explore, le filtre, ou le breakdown. Incohérence
interne pure.

## Problème 3 — Libellé « Custom » incohérent (EN vs FR) + catégories mixtes

- `DimensionSelector.tsx:176` : `{category === 'Custom' ? 'Custom Dimensions' : category}`
  → affiche **« Custom Dimensions »** (anglais).
- `ExploreFilterBuilder.tsx:515` : `{category === 'Custom' ? 'Dimensions personnalisées' : category}`
  → affiche **« Dimensions personnalisées »** (français, correct).

Donc le même groupe a deux noms selon l'écran. Par ailleurs les catégories
brutes affichées telles quelles sont en anglais (`Traffic`, `Device`, `Geo`,
`Time`, `Pages`, `Goal`, `User`) sauf `Téléphonie` (français) — l'utilisateur
français voit un mélange EN/FR dans les en-têtes de groupe.

## Demande précise

1. **Centraliser** l'ordre + le libellé d'affichage des catégories dans UN
   seul endroit (ex. `console/src/lib/explore-utils.ts`), p.ex. :
   ```ts
   export const CATEGORY_ORDER = ['Traffic', 'UTM', 'Channel', 'Pages',
     'Téléphonie', 'Goal', 'Device', 'Geo', 'Time', 'User', 'Custom']
   export const CATEGORY_LABELS_FR: Record<string, string> = {
     Traffic: 'Trafic', UTM: 'UTM', Channel: 'Canaux', Pages: 'Pages',
     Téléphonie: 'Téléphonie', Goal: 'Objectifs', Device: 'Appareils',
     Geo: 'Géographie', Time: 'Temps', User: 'Utilisateur',
     Custom: 'Dimensions personnalisées',
   }
   ```
2. Faire consommer ces constantes par les **3** sélecteurs (DimensionSelector,
   BreakdownModal, ExploreFilterBuilder) pour le tri ET l'affichage du libellé.
   Supprimer les 3 `categoryOrder` locaux et les ternaires `'Custom' ? ...`.
3. Placer `Téléphonie` à un rang cohérent (proposé : juste après `Pages`, c'est
   une source d'événements métier).

## Impact côté notre app (Veridian)

C'est exactement l'objectif Robert (« se fondre dans le natif, pas dénoter ») :
sans ça notre seule catégorie maison ressort en bas de liste, mal rangée, dans
un mélange EN/FR. Faible risque (UI pure, pas de backend, pas de migration).
Tier 🟢 BAS.

## Lien

Voir aussi `2026-06-19-ui-coherence-i18n-residus-anglais.md` (problème
`getDimensionLabel` qui rend `phone_source` → « Phone Source » au lieu de
« Source d'appel » — complémentaire à ce ticket).
