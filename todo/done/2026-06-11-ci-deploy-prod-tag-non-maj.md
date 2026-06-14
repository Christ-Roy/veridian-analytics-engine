# 🔴 CI prod déploie TOUJOURS l'ancienne image (tag non mis à jour)

> **Sévérité** : 🔴 P0 — la CI prod ment : "Deploy success" sans déployer le bon code
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-11

## Problème (découvert pendant la promo #23)

Le job `deploy-prod` de `prod-ci.yml` déclenche un `compose.deploy` Dokploy
(re-clone Git + `up -d`). Le `docker-compose.yml` prod résout l'image via
variable : `image: ghcr.io/.../veridian-analytics-engine:${ENGINE_IMAGE_TAG}`.

**Mais le workflow ne met JAMAIS à jour `ENGINE_IMAGE_TAG` / `BRIDGE_IMAGE_TAG`
dans l'env Dokploy du compose.** Ces variables sont stockées côté Dokploy
(env persistant, hors Git). Résultat : le build pousse bien
`prod-<sha>` + `:latest` sur GHCR, le deploy redéploie le compose… mais avec
l'ANCIEN tag figé (`prod-097da30` au moment de la promo #23). Le container ne
bascule jamais sur le nouveau code.

### Symptôme observé (promo #23, 2026-06-11)
- Job `Deploy prod (Dokploy API)` = **success**.
- Job `Playwright smoke prod` = **success** (il teste l'ancien container qui
  répond toujours — ne vérifie ni la version ni les nouvelles routes).
- Prod restée en **6.1.0** avec `webhooks.list → 404` pendant >3 min après le
  "success". Le delta promu (webhooks, fix G1, migration v7) N'ÉTAIT PAS en prod.

### Fix manuel appliqué pour débloquer #23
`compose.update` (API Dokploy trpc) sur composeId `RH8yiQGFLxTzVXtrvlNmB` :
`ENGINE_IMAGE_TAG` + `BRIDGE_IMAGE_TAG` → `prod-77ab053`, puis `compose.deploy`.
Bascule en 40s → 7.0.0, webhooks 401, migration v7 OK, 0 crash. Validé.

## Action attendue (durcir le workflow)

1. Dans `deploy-prod`, **AVANT** le `compose.deploy`, faire un `compose.update`
   qui POSITIONNE `ENGINE_IMAGE_TAG` et `BRIDGE_IMAGE_TAG` à
   `prod-${{ needs.build.outputs.engine_tag }}` (le SHA du run courant). L'env
   doit être patché sans écraser les secrets (merge, pas remplacement total —
   relire l'env via `compose.one`, remplacer les 2 lignes TAG, renvoyer).
2. **Durcir le smoke prod** pour qu'il échoue si la prod ne sert pas la
   nouvelle version : ajouter une assertion `GET /api/health` → `version ==`
   la version attendue (lire `api/src/version.ts`), OU vérifier une route
   nouvelle du build. Un smoke qui passe sur l'ancien container = inutile.
3. Vérifier que `rollback-prod` repointe bien le TAG (pas juste re-up) en cas
   d'échec.

## Pourquoi P0
Sans ce fix, AUCUNE promo prod de cet engine n'atteint réellement la prod, et
la CI le cache derrière un "success" vert + un smoke qui teste l'ancien code.
C'est un faux positif dangereux : on croit avoir déployé, on n'a rien déployé.

## Lien
- Run promo #23 : https://github.com/Christ-Roy/veridian-analytics-engine/actions/runs/27315263789
- composeId Dokploy : `RH8yiQGFLxTzVXtrvlNmB` (analytics-engine-prod)
- Workflow : `.github/workflows/prod-ci.yml` job `deploy-prod`

---
## ✅ RÉSOLU — 2026-06-14
Fix : `prod-ci.yml` step Deploy prod fait désormais `compose.update`
ENGINE_IMAGE_TAG/BRIDGE_IMAGE_TAG=prod-<sha> (tag immuable) AVANT compose.deploy
→ auto-pull garanti, plus de container figé. + health check sur l'engine (pas le
bridge) + smoke provisionApiKey≠404 pour détecter un faux "deploy success".
Commit b1c98d2, promu main, validé prod (`.env` Dokploy = ENGINE_IMAGE_TAG=prod-b1c98d2).
