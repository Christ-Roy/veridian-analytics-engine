# prod-ci health check timeout vs compose.deploy Dokploy async → faux négatif + rollback parasite

> **Sévérité** : 🟡 P1 (gate prod donne des faux négatifs + déclenche rollback inutile)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17 (team-lead, sprint GIGA vague C)

## Constat (promos 4a959ba + be8e2cb, 2026-06-17)

Le job `deploy-prod` de `prod-ci.yml` :
1. appelle `compose.deploy` Dokploy → réponse immédiate `{"message":"Deployment queued"}`,
2. enchaîne un health check qui poll `/api/health` jusqu'à version == APP_VERSION.

PROBLÈME : `compose.deploy` est **asynchrone** (queue). Le clone git + pull images
+ recreate containers + **migrate-on-boot v8→v9** + bootstrap NestJS prend
**> 6 min** sur prod. Le health check (même porté à 6min) timeout AVANT que le
nouveau container soit healthy → job `deploy-prod` = FAILURE → `rollback-prod`
auto se déclenche.

Or le deploy a en fait RÉUSSI (vérifié les 2 fois : prod sur le bon tag/version
quelques minutes après, ENV 23 vars préservée par le fix merge, Dokploy deploy
log = "done / Docker Compose Deployed ✅"). Donc :
- **faux négatif** : le workflow marque failure alors que la prod est bonne.
- **rollback parasite** : heureusement INOPÉRANT ici (le rollback retag
  `:rollback`→`:latest` côté images mais le compose utilise `ENGINE_IMAGE_TAG=prod-<sha>`
  explicite, pas `:latest` → l'ENV n'est pas touchée, le tag reste le bon). MAIS
  c'est de la chance, pas du design : un rollback qui marcherait casserait une
  prod en fait saine.

## À faire

1. **Découpler** : après `compose.deploy`, poller le **statut du déploiement Dokploy**
   (`GET /api/deployment.allByCompose?composeId=...` → `status` du dernier = `done`/`error`)
   AVANT de faire le health check applicatif. Ne health-check que quand Dokploy dit `done`.
2. OU augmenter franchement le budget (12-15 min) ET conditionner le rollback à un
   vrai échec Dokploy (`status=error`), pas au seul timeout du health check.
3. **Rendre le rollback sûr** : il doit re-pin un `ENGINE_IMAGE_TAG`/`BRIDGE_IMAGE_TAG`
   précédent connu-bon (capturé avant le deploy) via compose.update MERGE, pas retag
   `:latest` (inopérant sur ce setup GitOps). Sinon le retirer (faux sentiment de filet).
4. Idéalement : un endpoint `/api/version` exposant le **git SHA** (pas juste APP_VERSION
   qui ne bouge qu'aux migrations majeures) → health check précis par-commit.

## Note

La prod de la vague revoke+voip+gsc est LIVRÉE et SAINE (engine v9.0.0, prod-be8e2cb,
3 modules OK). Ce ticket = fiabiliser le GATE pour les futures promos, pas un incident
prod ouvert. Le fix merge-ENV (commit d557086) est lui VALIDÉ et fonctionne.
