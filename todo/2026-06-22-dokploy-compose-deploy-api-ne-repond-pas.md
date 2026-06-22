# 🟡 Dokploy : l'API `compose.deploy` ne répond pas → deploy CI bloqué (contourné en SSH)

> **Sévérité** : 🟡 P1 (dette infra — bloque le deploy prod automatique)
> **Owner** : agent engine / infra · **Créé** : 2026-06-22

## Constat (2026-06-22)
Le deploy prod CI de `3cb2873` (surface M2M) a échoué puis hang : le job
`Deploy prod (Dokploy API)` restait `in_progress` indéfiniment. Diagnostic :
- `POST https://dokploy.veridian.site/api/compose.deploy` (composeId
  `RH8yiQGFLxTzVXtrvlNmB`) **ne renvoie RIEN** (réponse vide, pas de HTTP code) et
  **ne crée aucun déploiement** (le dernier dans `deployment.allByCompose` restait
  "done" du 06-20). Testé plusieurs fois.
- Pourtant Dokploy est **vivant** : UI `https://dokploy.veridian.site` = 200,
  container `dokploy.1` Up healthy. Donc c'est l'endpoint `compose.deploy`
  spécifiquement qui ne répond pas (lock interne ? deploy fantôme bloquant ?).

## Contournement appliqué (a marché)
Deploy **direct en SSH** avec la commande exacte que Dokploy lance :
```
cd /etc/dokploy/compose/analytics-engine-prod-gkggyk/code
git reset --hard origin/main          # clone sur 3cb2873
sed -i 's/^ENGINE_IMAGE_TAG=.*/ENGINE_IMAGE_TAG=prod-3cb2873/' compose/.env
sed -i 's/^BRIDGE_IMAGE_TAG=.*/BRIDGE_IMAGE_TAG=prod-3cb2873/' compose/.env
docker compose -p analytics-engine-prod-gkggyk --env-file compose/.env \
  -f compose/base.yml -f compose/prod.yml up -d
```
→ surface M2M `prod-3cb2873` en prod, health 200, endpoints M2M répondent.
Le fix réseau dokploy-network (compose) s'est appliqué proprement au passage.

## À corriger
1. **Investiguer pourquoi `compose.deploy` API ne répond pas** : redémarrer le
   container Dokploy ? deploy fantôme `in_progress` côté Dokploy à purger ? Vérifier
   les logs Dokploy.
2. ⚠️ **Divergence ENV** : j'ai édité `compose/.env` du clone à la main
   (ENGINE/BRIDGE_IMAGE_TAG=prod-3cb2873). L'ENV stocké en BASE Dokploy (servi par
   `compose.one`) peut diverger. Au prochain deploy CI réussi, le merge-ENV du
   workflow le resync. À vérifier.
3. Le workflow `prod-ci.yml` devrait **détecter le hang** (timeout sur le poll
   `wait-dokploy-deploy.sh`) au lieu de rester in_progress indéfiniment.

## Impact
Aucun downtime (prod restée saine sur l'ancienne image pendant l'incident). Mais le
deploy prod automatique est cassé tant que l'API Dokploy ne répond pas → tout deploy
doit passer en SSH manuel en attendant. À résoudre vite.
