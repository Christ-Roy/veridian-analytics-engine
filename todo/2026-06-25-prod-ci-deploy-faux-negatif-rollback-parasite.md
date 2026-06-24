# prod-ci : "Deploy prod" faux négatif → rollback parasite (deploy réussit pourtant)

> **Sévérité** : 🟡 P1 (rollback parasite sur un deploy sain = risque + bruit)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-25

## Symptôme (vu 2× : 2026-06-17 et 2026-06-25 promo 8 fixes)
Le job "Deploy prod (Dokploy API)" du `prod-ci.yml` sort FAILURE et déclenche le
"Rollback prod (auto on failure)", ALORS QUE le deploy a RÉUSSI : prod répond
v11.0.0 healthy, et le grep du container confirme le nouveau code servi
(stripUndefined=3, exposeUnsetFields:false, activateIfInitializing=3, verify exit 0).
Le health-check Dokploy async fait un faux négatif pendant le recreate (health
momentanément down → CI croit échec → rollback). Le rollback n'a PAS recassé la
prod cette fois (le code des fixes est bien en place), mais c'est de la chance —
un rollback parasite PEUT remettre l'ancien code.

## Cause
Même racine que le ticket déjà documenté (mémoire feedback_prod_ci_dokploy_async_pieges) :
le health-check post-deploy ne distingue pas "recreate en cours" de "deploy
échoué". Le `wait-dokploy-deploy.sh` poll le statut Dokploy mais le job Deploy
lui-même conclut failure avant.

## Correctif
Durcir le job "Deploy prod" : ne conclure failure QUE si le statut Dokploy =
error/timeout APRÈS le grace (8min), confirmer par un grep du code servi OU une
version applicative bumpée, et ne déclencher le rollback QUE sur un vrai échec
fonctionnel (health 5xx persistant OU code non déployé), pas sur un health
transitoire pendant le recreate. Aligner sur le pattern déjà partiellement durci.

## Impact
Rollback parasite = risque de re-déployer l'ancien code sur un deploy sain +
alerte trompeuse "rollback" qui fait croire à un incident. À durcir.
