# 🔴 La mega-battery `e2e-full-staging` est périmée → gate prod inopérant (cancel systématique)

> **Sévérité** : 🔴 P1 (le gate E2E lourd censé protéger la prod ne passe JAMAIS)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-18
> **Source** : team-lead, tentative d'utiliser le gate avant promo vague P1

## Constat (vérifié sur les runs réels)

**TOUS** les runs `e2e-full-staging.yml` sont `cancelled` — pas seulement le mien
déclenché manuellement, mais aussi les runs `schedule` quotidiens (16, 17, 18
juin). Le gate E2E lourd ne produit JAMAIS de verdict vert/rouge exploitable.

Cause : le step 5 « Full battery staging (all P0+P1 suites) » tourne ~35 min puis
**timeout → cancel** (steps suivants skipped). Le timeout est dépassé parce que
la suite est lente ET pleine de tests qui retry×2 sur des **features qui
n'existent plus** dans la vision figée 2026-05-23.

## Tests qui échouent = features MORTES (débranchées par la vision)

Échecs en masse (✘ 172-211) sur des specs legacy pointant vers l'ancien monde :
- `09-dashboard-ui/dashboard-sections-render.spec.ts` : `score-value` (Score
  Veridian **débranché** 2026-05-23), `shadow-marketing-grid` (**débranché**),
  `active-services-grid`.
- `09-dashboard-ui/tabs-navigation.spec.ts` : deep-links `/veridian`, `/leads`
  (routes custom **supprimées** par la règle « pas de sous-route Veridian »).
- `10-onboarding-wizard/welcome-route.spec.ts` : `/welcome` snippet tracker,
  `/api/tracker.detect` — à revérifier vs l'état réel.
- `08-voip-calls/voip-endpoints.spec.ts` : routes `/api/voip/sync`,
  `/api/voip/calls`, `/api/voip/sipcall` testées en `401/404` — l'API réelle est
  `voip.sync` (RPC-style), pas `/api/voip/sync` REST → specs sur un contrat périmé.

Ces specs encodent un produit qui a été explicitement démantelé. Elles ne
peuvent pas réussir et font timeout la suite.

## Impact

- **Le gate de promo prod tier 🔴 est inopérant.** On ne peut pas s'appuyer
  dessus pour valider une vague avant main. (Pour la vague P1 du 2026-06-18, la
  validation s'est faite sur la CI `Staging CI/CD` verte — 530 tests E2E
  ClickHouse réels — + vérif manuelle des features livrées sur staging.)
- Les runs nightly `schedule` échouent en silence depuis ≥ 3 jours → aucune
  surveillance E2E réelle de la prod/staging.

## Demande précise (chantier dédié, hors vague P1)

1. **Purger les specs de features mortes** : supprimer/réécrire
   `dashboard-sections-render` (score/shadow/services), `tabs-navigation`
   (deep-links veridian/leads), aligner `voip-endpoints` sur le vrai contrat
   `voip.sync` RPC. Cible : la suite ne teste QUE le produit réel (3 features du
   scope : visiteurs uniques natif + Calls + GSC).
2. **Réduire le temps de suite** sous le timeout (sharding, ou retoucher
   `timeout-minutes`, ou `--workers`).
3. **Rendre le verdict exploitable** : un run doit conclure success/failure, pas
   cancel.

Tant que ce n'est pas fait, le gate E2E lourd ne protège rien. La CI
`Staging CI/CD` (Jest API contre ClickHouse réel) reste le rempart fiable.
