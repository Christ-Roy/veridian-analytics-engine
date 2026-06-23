# E2E gate on-premise : grace "wait healthy" 5 min trop court (faux échec sur migration)

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Symptôme
Le nouveau gate `.github/workflows/e2e-gate-onpremise.yml` attend que staging soit
healthy AVANT de lancer les specs : `for i in $(seq 1 30); do ... sleep 10` = 5 min max
(ligne ~81-91). Or un deploy staging qui joue une migration lourde (V10 visitor_id,
recreate + crash-loop temporaire vu le 2026-06-23) peut rendre staging DOWN > 5 min.
→ le gate sort en `failure` "Staging jamais healthy après 5 min" alors que staging
redevient sain juste après. FAUX NÉGATIF qui bloque la promo.

## Correctif proposé
Porter le grace à ~12 min (`seq 1 72` × sleep 10, en restant sous le `timeout-minutes: 15`),
OU mieux : poller le statut Dokploy du déploiement (comme prod-ci.yml le fait déjà,
`scripts/ci/wait-dokploy-deploy.sh`, source de vérité = deployment status done/error)
plutôt qu'un health applicatif naïf. Aligner sur le pattern prod-ci durci 2026-06-17.

## Impact si non corrigé
Chaque promo qui embarque une migration déclenchera un faux échec du gate → friction
+ tentation de bypasser le rempart. À durcir avant la prochaine vague avec migration.
