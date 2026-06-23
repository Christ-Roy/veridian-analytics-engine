# 🔴 Métrique M2M `pageviews` → HTTP 500 en prod (route publique `analytics.query` qui crashe)

> **Sévérité** : 🟡 P1 (route M2M exposée qui renvoie 500 — incohérence app/feature)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17 · **Re-vérifié + ré-sévérisé** : 2026-06-23 (contre prod réelle)

## Constat — VÉRIFIÉ EN PROD le 2026-06-23 (toujours cassé)

```
$ analytics --env prod query vrd_veridian_site_prod --metrics pageviews --preset previous_30_days
{ "statusCode": 500, "message": "Internal server error" }
```

`metrics.ts:65-67` : `pageviews: { sql: "countIf(name = 'screen_view')" }`. La colonne `name`
n'existe pas sur la table `sessions` (elle est sur `events`) → ClickHouse jette
`Unknown expression or function identifier 'name'`. La query M2M `analytics.query` renvoie un 500 brut.

**Pour comparaison (vérifié même run)** : `sessions` → 200 (332), `unique_visitors` → 200 (1).
Donc c'est bien **spécifique à `pageviews`**, pas une panne globale de la query.

## ⚠️ Le "contournement page_count" annoncé NE MARCHE PAS via M2M

L'ancienne version du ticket disait "utiliser `page_count`". VÉRIFIÉ FAUX côté M2M :
```
$ analytics --env prod query vrd_veridian_site_prod --metrics page_count ...
{ "message": "Metric 'page_count' is not available for table 'sessions'", "statusCode": 400 }
```
`page_count` est sur la table `pages`, pas `sessions` → il faut `table:"pages"` explicite. Donc un
consommateur M2M qui veut "des pages vues" n'a AUCUNE métrique qui marche en mode défaut (table sessions).

## Pourquoi c'est P1 (et plus P2)

`analytics.query` est une **route M2M publique exposée** (Bearer plateforme, consommée par le Hub,
le skill, le CLI, et bientôt une couche MCP). Une métrique au catalogue qui throw 500 = contrat API
cassé + mauvaise impression IA-first. La doc `ANALYTICS_REFERENCE.md:26` la présente même comme
fonctionnelle (cf chantier doc D1) → un intégrateur qui suit la doc se prend un 500.

## Fix (le plus propre)
1. **Corriger le SQL de `pageviews`** pour qu'il marche sur la table où il est routé, OU
2. **Retirer la métrique morte** du catalogue (`metrics.ts`), OU
3. **L'aliaser proprement** vers la vraie métrique pages avec le bon routage de table.
Décider en fonction du routeur de table de l'analytics service. Tester contre le VRAI ClickHouse
(pas les mocks unitaires — c'est un test M2M réel qui a révélé le bug, pas l'unitaire).
4. Mettre `ANALYTICS_REFERENCE.md` en cohérence dans la même passe (cf `CHANTIER-doc-parite-code` D1).

## Note de robustesse liée (à voir avec ce fix)
Le **routage de table implicite** est friable : une query `goals` sans `table:"goals"` tape `sessions`
→ 400. Le moteur devrait router la table d'après les métriques demandées, ou le contrat doit imposer
`table`. Lot dans `2026-06-23-robustesse-mineure-divers-p2-p3.md`.
