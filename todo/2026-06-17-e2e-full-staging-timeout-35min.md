# e2e-full-staging.yml timeout systématique (35min) → gate E2E inutilisable

> **Sévérité** : 🟡 P1 (gate Pilier 5 cassé)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17 (team-lead, sprint GIGA vague C)

## Constat

Le workflow `e2e-full-staging.yml` (mega-battery Playwright, 21 catégories de
specs chromium+webkit contre staging réel) **timeout systématiquement** à
`timeout-minutes: 35`. Les 3 derniers runs sont TOUS `cancelled` au timeout :
- run 27692223650 (bafe9d9) créé 13:24 → cancelled ~13:59 (~35min)
- run 27671748411 (ad14214) cancelled
- run 27601058958 (b1c98d2) cancelled

→ Le gate de validation finale (Pilier 5 du skill team-orchestration) est de
facto INUTILISABLE : il ne conclut jamais success/failure, toujours cancelled.

## Cause probable

21 catégories de specs (01-smoke … 21-anti-regression) × 2 navigateurs
(chromium + webkit) contre staging réel HTTP = > 35 min. Le timeout est trop
court OU la suite trop large pour un seul job.

## À faire (options)

1. **Sharding** : découper en N jobs parallèles (matrix par dossier de specs),
   chacun < 35min. Pattern Playwright `--shard=i/N`.
2. **OU** augmenter timeout-minutes (60-90) si le coût runner est acceptable.
3. **OU** séparer : un job "smoke + modules critiques" rapide (gate bloquant)
   + un job "full 21 catégories" nightly informatif (non bloquant).
4. Réduire webkit aux specs où il apporte (garder chromium partout, webkit
   ciblé responsive/visual).

## Contournement immédiat (sprint en cours)

Pour la promo prod de la vague revoke+voip+gsc, le team-lead lance un
sous-ensemble ciblé (05-gsc-oauth, 07-settings-credentials, 08-voip-calls,
17-multi-tenant, 18-api-contract) via container Playwright sur dev-pub, en
plus de la CI staging déjà verte (unit + e2e ClickHouse réel + deploy + smoke).
