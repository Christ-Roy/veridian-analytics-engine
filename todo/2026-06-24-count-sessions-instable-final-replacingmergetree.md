# Le total de sessions n'est pas stable : 2 requêtes identiques renvoient 147 puis 160 (count() FINAL sur ReplacingMergeTree)

> **Sévérité** : 🔴 P0 — le même chiffre de sessions change entre deux chargements, le client voit des totaux qui bougent sans raison
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24

## Symptôme (reproductible, horodaté sur staging)

Workspace `vrd_veridian_site_staging`, métrique `sessions`, preset `all_time`, EXACTEMENT la même requête, à quelques minutes d'écart pendant un audit :

| Moment | `query --metrics sessions --preset all_time` | `--dimensions channel_group` |
|---|---|---|
| T0 (début audit) | **147** | `"" : 146`, `direct : 1` (somme = 147 ✓) |
| T0 + ~5 min | — | `direct : 12` (via endpoint conversions, même fenêtre) |
| T0 + ~8 min | — | `"" : 146`, `direct : 14` (somme = **160**, ✗ ≠ 147) |
| T0 + ~10 min | **160** | — |
| 3 mesures consécutives à 25 s d'écart | **160 / 160 / 160** (stable) | — |

→ Le total est passé de **147 à 160** puis s'est stabilisé. Le canal `direct` a dérivé **1 → 12 → 14**. `unique_visitors` est resté **stable à 2** sur toute la période (cf ci-dessous, c'est la clé du diagnostic).

Commandes exactes :
```
analytics --env staging query vrd_veridian_site_staging --metrics sessions,unique_visitors --preset all_time
analytics --env staging query vrd_veridian_site_staging --metrics sessions --dimensions channel_group --preset all_time
```

## Cause probable

Toutes les requêtes sessions sont des `SELECT count() ... FROM sessions FINAL`. La table (`api/src/database/schemas.ts` L415-491) :

```
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (created_at, id)        ← clé de dédup = (created_at, id), PAS id seul
```

Et `sessions_mv` (L493+) est un MV d'agrégation `GROUP BY id` qui réinsère la session à chaque **bloc** d'événements (`any(e.created_at) as created_at`, `max(e.updated_at) as updated_at`).

Deux mécanismes peuvent produire l'instabilité observée, à départager :

1. **`count() ... FINAL` non déterministe tant que les parts ne sont pas mergées.** `FINAL` déduplique au query-time, mais sur un ReplacingMergeTree avec des parts fraîchement insérées et pas encore mergées, le comptage peut varier selon l'état des parts au moment de la requête (c'est un piège ClickHouse connu : `count()` sur table FINAL n'est fiable qu'après merge, ou avec un `GROUP BY id` explicite / `count(DISTINCT id)`).

2. **Clé de dédup `(created_at, id)` fragile.** Si pour un même `id` deux blocs MV émettent un `created_at` différent (parce que `any(e.created_at)` n'est pas garanti déterministe entre blocs quand les events d'une session sont splittés sur plusieurs inserts), alors ReplacingMergeTree voit **deux lignes de clés distinctes** pour la même session → doublons jamais fusionnés → sur-comptage permanent. La montée 147→160 et `direct` 1→14 colle avec une session (ou un seed) dont les events se matérialisent par vagues.

Le fait décisif : **`uniqExact(visitor_id)` reste à 2 pendant que `count()` monte de 147 à 160.** `uniqExact` dédoublonne par valeur, il est immunisé contre les doublons de lignes ; `count()` non. Cela prouve que ce sont des **lignes de session dupliquées** (même session comptée plusieurs fois), pas de vraies nouvelles sessions.

## Correctif (voie propre)

1. **Reproduire en SQL direct sur ClickHouse staging** (DB système du workspace) pour départager mécanisme 1 vs 2 :
   - `SELECT count() FROM sessions` (sans FINAL) vs `SELECT count() FROM sessions FINAL` vs `SELECT uniqExact(id) FROM sessions` — si les trois divergent, c'est la dédup ; si seul FINAL est instable, c'est le merge.
   - `SELECT id, count() c, uniqExact(created_at) FROM sessions GROUP BY id HAVING c > 1` — liste les sessions dupliquées et vérifie si leur `created_at` varie (→ confirme mécanisme 2).
2. **Si mécanisme 2** (created_at non stable dans la clé de dédup) : la clé de tri du ReplacingMergeTree doit garantir 1 ligne par session. Soit `ORDER BY (id)` (mais casse le partitionnement par date pour le pruning), soit s'assurer que `created_at` est rigoureusement figé (déjà censé l'être via SDK timestamp — vérifier que `any()` ne dérive pas). Migration de table sensible → tester intégralement sur staging, snapshot avant (cf `project_blue_green_pattern`).
3. **Si mécanisme 1** (count FINAL non fiable) : remplacer `count()` par `count(DISTINCT id)` ou `uniqExact(id)` dans le query-builder pour la métrique `sessions` — robuste aux parts non mergées, comme l'est déjà `unique_visitors`. C'est le fix le moins risqué et le plus probablement suffisant.

Recommandation : commencer par (3) — aligner la métrique `sessions` sur `uniqExact(id)` comme `unique_visitors` l'est déjà sur `uniqExact(visitor_id)`. C'est cohérent, ça supprime l'instabilité visible, et ça ne touche pas le schéma. Vérifier ensuite (1)/(2) en SQL pour la dette de fond.

## Impact

- **Tous** les chiffres de sessions montrés au client (dashboard, status `sessions_30d`, conversions `sessions` dénominateur, query, exports) sont potentiellement sur-comptés et **non reproductibles** entre deux chargements.
- Le dénominateur du endpoint `conversions` hérite directement de ce bug (cf ticket `2026-06-24-conversions-denominateur-partage-par-app.md` : son `sessions` par canal vient de la même requête `count() FROM sessions FINAL GROUP BY channel_group` → c'est lui qui donnait `direct: 12` alors que la query directe donnait `direct: 1`).
- Affecte la confiance fondamentale dans l'outil : « le nombre de visites change quand je rafraîchis » est un défaut rédhibitoire pour un produit analytics commercialisé.
