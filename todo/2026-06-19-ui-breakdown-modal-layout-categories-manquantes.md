# BreakdownModal : layout 4-colonnes en dur n'affiche pas Téléphonie/Goal/User

> **Sévérité** : 🔵 P3
> **Owner** : agent engine
> **Créé** : 2026-06-19
> **Découvert par** : fix-finitions (vague harmonisation UI)

## Constat

Le `BreakdownModal` (`console/src/components/explore/BreakdownModal.tsx`) a un
layout **4-colonnes codé en dur** qui n'affiche QUE certaines catégories de
dimensions — il n'affichait DÉJÀ PAS (avant la vague UI) les catégories
`Téléphonie`, `Goal`, `User`. La vague harmonisation a centralisé l'ORDRE et les
LIBELLÉS des catégories dans `lib/explore-utils.ts` (`CATEGORY_ORDER`,
`CATEGORY_LABELS_FR`) et câblé les 3 sélecteurs dessus, mais le **tri ≠ layout** :
le BreakdownModal trie désormais correctement, mais son layout manuel à 4 colonnes
ne mappe pas toutes les catégories → `Téléphonie` (nos dimensions VoIP
`phone_source`/`phone_direction`/`phone_status`) reste invisible dans CE
sélecteur précis.

Les 2 AUTRES sélecteurs (`DimensionSelector` d'Explore + `ExploreFilterBuilder`)
affichent bien `Téléphonie` au bon rang — donc la dimension EST accessible, juste
pas via le BreakdownModal.

## Impact

Faible : l'utilisateur peut grouper/filtrer par `phone_source` via Explore et le
filter builder ; seul le breakdown modal (un chemin secondaire) ne propose pas la
catégorie Téléphonie. Cohérence incomplète, pas un blocage.

## Demande précise

Refondre le layout du `BreakdownModal` pour qu'il itère sur TOUTES les catégories
de `CATEGORY_ORDER` (comme `DimensionSelector`), au lieu d'un mapping 4-colonnes
figé. Réutiliser `sortCategoriesByOrder` + `getCategoryLabel` de
`lib/explore-utils.ts` (déjà en place). Hors scope de la vague finitions (refonte
de layout, pas un quick-win).
