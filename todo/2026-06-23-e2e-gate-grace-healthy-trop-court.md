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

## MAJ 2026-06-24 — défaut PERSISTANT, re-bloqué 3× (à durcir pour de bon)
Le gate `e2e-gate-onpremise.yml` a re-bloqué 3× lors de la promo des fixes HUNT
(2026-06-24) sur le step `Wait for staging to be healthy`, ALORS QUE staging
répondait 200 via `analytics --env staging doctor` au même instant. Le step
`curl https://analytics-engine.staging.veridian.site/api/health` via Traefik/tailnet
flotte (000/timeout intermittent), surtout pendant le recreate post-deploy. Grace
30×10s = 5 min insuffisant. → faux négatif systématique à chaque promo avec recreate.

### Correctif RECOMMANDÉ (le plus propre)
Le gate tourne DÉJÀ sur dev-pub via SSH (car staging = tailnet). Donc le
health-check du step `Wait for staging healthy` doit aussi se faire **DEPUIS
dev-pub en local** (bypass Traefik/tailnet) : `ssh dev-pub 'docker exec
analytics-engine-staging-engine-1 wget -qO- http://localhost:3000/api/health'`
OU `curl http://localhost:3000/api/health` depuis dev-pub. C'est la même machine
qui exécute les specs → cohérent + fiable (pas de Traefik dans le chemin).
Alternative : poller le statut Dokploy (deployment done/error) comme `prod-ci.yml`.
Augmenter juste le grace à 12 min = pansement, pas le vrai fix (le flottement
Traefik persiste). Sévérité relevée 🟢→🟡 (bloque les promos en pratique).
