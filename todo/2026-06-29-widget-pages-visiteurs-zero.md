# Widget "Pages les plus consultées" : colonne Visiteurs = 0 partout

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-29
> **Révélé par** : fix incident toFixed (b95e022) — le crash masquait ce bug data.

## Symptôme (observé en prod, ASD + yoga_sculpt)

Sur le dashboard, widget **"Pages les plus consultées"** (onglet Pages d'entrée) :
la colonne **Visiteurs affiche `0` sur toutes les lignes** (/, /services, /contact…)
alors que la colonne Visites a des valeurs réelles (1.4K, 450…) ET que le KPI
en haut "Visiteurs uniques" affiche bien 3.2K (ASD) / 45 (yoga).

→ Incohérence : `unique_visitors` est correctement agrégé au niveau global (KPI)
mais vaut 0 dans le breakdown par page. C'est ce `undefined`/0 sur `unique_visitors`
qui, avant b95e022, faisait crasher `.toFixed()` (cf incident). Le fix défensif
(`cellNumber`) tombe désormais sur 0 → plus de crash, mais la donnée reste fausse.

## Piste

Probable suite du renommage `sessions` → `unique_visitors` (commit fd91e83) :
la requête de breakdown par `landing_path` / `entry_path` ne sélectionne/agrège
peut-être pas la métrique `unique_visitors` (uniqExact visitor_id) pour ce widget,
ou le `dimensionField`/registre du tab Pages ne mappe pas la colonne. À vérifier :
- `DimensionTabConfig` du widget Pages (`metrics: [...]` inclut-il `unique_visitors` ?)
- la requête backend `analytics.query` table `pages` renvoie-t-elle `unique_visitors` ?
- cohérence avec [[feedback_worktree_partage_commit_base_perimee]] (métrique
  unique_visitors désynchronisée du registre, déjà vue causer sessions_30d=0).

## Critère

Colonne Visiteurs du widget Pages affiche des valeurs cohérentes avec les Visites
(et ≤ Visites par ligne). Vérifier on-premise contre ClickHouse réel (un mock
masquerait le bug — cf [[feedback_mock_cache_le_bug_tester_clickhouse_reel]]).
