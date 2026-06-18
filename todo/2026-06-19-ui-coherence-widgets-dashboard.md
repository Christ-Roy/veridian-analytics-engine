# Cohérence des widgets du dashboard (layout + libellés + click-to-filter)

> **Sévérité** : 🟡 P1 — un widget cassé + un layout orphelin
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-dashboard (UI-2)

## Contexte

Audit des widgets de `DashboardGrid.tsx`. Le composant `DimensionTableWidget`
est générique et bien fait : nos colonnes custom (« Pages les plus vues ») et
les widgets natifs (« Pages d'entrée »/« Sorties ») passent par le **même**
rendu, mêmes formats, même style de carte → bonne nouvelle, le widget Veridian
ne dénote PAS structurellement. Les formats `percentage` (`page_scroll`,
`exit_rate`) sont bien gérés et à la bonne échelle (0-100, identique au natif
`median_scroll`). 3 incohérences réelles malgré tout.

## Problème 1 — Click-to-filter cassé sur l'onglet « Sorties » (BUG)

`console/src/components/dashboard/DashboardGrid.tsx` :
- l.237 : la config de l'onglet a `key: 'exits'`
- l.375 : le mapping `tabKeyToDimension` a la clé `exit: 'exit_path'` (sans `s`)

Quand l'utilisateur clique une ligne dans l'onglet **« Sorties »**, le handler
`handleRowClick` (l.398-408) fait `tabKeyToDimension['exits']` → `undefined`
→ `if (!dimension) return` → **rien ne se passe**. Le click-to-filter marche sur
le widget natif voisin « Pages d'entrée » (`landing` mappé correctement) mais
pas sur « Sorties ». Incohérence fonctionnelle entre deux onglets du même widget.

### Fix (quick-win 1 ligne — signalé, NON appliqué car audit lecture seule)

`DashboardGrid.tsx:375` : remplacer `exit: 'exit_path',` par
`exits: 'exit_path',` (aligner sur la `key` de la config).

## Problème 2 — Widget « Pages les plus vues » : layout orphelin

`DashboardGrid.tsx:505-517` : le widget « Pages les plus vues » est placé seul
dans une rangée `grid grid-cols-1 md:grid-cols-2` → en desktop il occupe la
colonne gauche et **laisse la moitié droite vide**. Toutes les autres rangées du
dashboard ont 2 widgets côte à côte (Pages+Sources, Campagnes+Pays,
Heatmap+Appareils). Cette rangée à 1 seul widget casse la grille — c'est
typiquement ce qui fait « dénoter » un ajout Veridian.

### Demande

Repositionner « Pages les plus vues » pour remplir la grille. Options :
- **(reco)** le mettre en binôme avec un widget natif dans une rangée à 2 (ex.
  l'apparier avec « Objectifs » qui est lui aussi seul en bas, l.554-563), OU
- le fusionner comme onglet supplémentaire du widget natif « Pages les plus
  consultées » (l.481-485) — cohérent sémantiquement (entrée / sortie / vues),
  mais ATTENTION : techniquement la table diffère (`pages` vs `sessions`) et le
  click-to-filter est désactivé sur `page_path` (cf commentaire l.506-509), donc
  l'apparier en rangée à 2 est plus simple et plus sûr.

Choisir l'option qui garde la grille pleine et l'ordre de lecture logique.

## Problème 3 — Libellé divergent pour la même métrique (scroll)

Même métrique conceptuelle « profondeur de scroll médiane » (SQL identique
`round(median(max_scroll), 1)`, cf `api/src/analytics/constants/metrics.ts:41`
et `:93`), libellée différemment selon l'écran :
- Notre colonne widget : **« Scroll médian »** (`DashboardGrid.tsx:367`)
- Natif Explore / ExploreSummary : **« Profondeur de scroll médiane »**
  (`ExploreTable.tsx:373`, `ExploreSummary.tsx:205`)
- KPI dashboard : « Profondeur de scroll médiane » (`types/dashboard.ts:170`)

### Demande

Uniformiser le libellé de la colonne `page_scroll` du widget « Pages les plus
vues » sur le terme natif. Si « Profondeur de scroll médiane » est trop long
pour la colonne étroite, utiliser « Scroll médian » mais alors l'adopter
partout — choisir UN terme. Idem vérifier « Temps médian » (`page_duration`,
l.366) vs « TimeScore » natif : ce sont deux métriques différentes (durée page
vs durée session), donc OK de garder distinct, mais s'assurer que le tooltip du
widget l.512 le précise (actuellement il dit « temps médian passé » — OK).

## Note positive (rien à faire)

- États vide/loading/erreur : cohérents (`Empty` + `Empty.PRESENTED_IMAGE_SIMPLE`
  + `Spin` partout, mêmes classes). Nos `emptyText` FR (« Aucune donnée de
  page ») suivent le pattern natif.
- Tokens : aucune couleur en dur parasite, tout passe par `var(--primary)` /
  `var(--background)` / palette tailwind gray cohérente avec le natif.
- Format `percentage` : bien géré, bonne échelle, pas de bug 0-1 vs 0-100.

## Impact

Problème 1 = bug fonctionnel (filtre mort) → P1. Problèmes 2 et 3 = cosmétique
mais c'est précisément « se fondre dans le natif ». Tier 🟢 BAS (UI pure, pas de
backend). Le fix #1 est trivial.
