# deploy/ — GitOps Nomad (analytics-engine)

Source de vérité du déploiement **Nomad** de l'analytics-engine (prod + staging).
Remplace l'ancien GitOps Dokploy (décommissionné 2026-07-10, migration cluster
Nomad 3 nœuds terminée).

## Fichiers

| Fichier | Job | Nœud | Route | Secrets Nomad Var |
|---|---|---|---|---|
| `analytics-engine.nomad.hcl` | `analytics-engine` (prod) | `contabo` (bastion) | `analytics-engine.app.veridian.site` (public, Let's Encrypt) | `nomad/jobs/analytics-engine` |
| `analytics-engine-staging.nomad.hcl` | `analytics-engine-staging` | `ovh-dev` | `analytics-engine.staging.veridian.site` (privé Tailscale, `internal-only@nomad`) | `nomad/jobs/analytics-engine-staging` |

Chaque job = 4 tasks dans UN group réseau `bridge` partagé (127.0.0.1) :
`clickhouse` + `postgres-bridge` (STATEFUL, volumes bind → group épinglé au nœud
via `constraint provider`) + `engine` + `bridge` (bumpés par la CI).

Les deux HCL **déclarent `variable "image_tag"`** — la CI injecte le tag buildé
(`prod-<sha7>` / `staging-<sha7>`). Les images engine ET bridge partagent ce tag
(le build en produit les deux par run). Secrets : **jamais en clair** — Nomad
Variables + `template{env=true}`.

## Flux CI (pattern identique prospection)

1. Build + push images `ghcr.io/christ-roy/veridian-analytics-{engine,bridge}:<prefix>-<sha7>`.
2. Deploy job : **SSH → bastion** (`NOMAD_BASTION_HOST`/`_USER`/`NOMAD_DEPLOY_SSH_KEY`),
   scp du HCL **de ce repo** (celui qui déclare `variable "image_tag"`), puis IN SITU
   sur le bastion : `source ~/credentials/nomad-bastion.env` → `nomad job validate/plan/run
   -detach -var image_tag=<tag>`. **Le NOMAD_TOKEN ne quitte jamais le bastion.**
3. Poll `nomad job status` jusqu'à `Latest Deployment = successful`.

Secrets GH repo requis (provisionnés) : `NOMAD_BASTION_HOST`, `NOMAD_BASTION_USER`,
`NOMAD_DEPLOY_SSH_KEY` (clé dédiée `analytics-engine-ci-deploy@github`, publique dans
l'`authorized_keys` du bastion).

## Runbook manuel (depuis le bastion)

```bash
source ~/credentials/nomad-bastion.env && export NOMAD_ADDR NOMAD_TOKEN="$NOMAD_MGMT_TOKEN"
TAG=staging-<sha7>   # ou prod-<sha7>
/usr/bin/nomad job validate -var "image_tag=$TAG" deploy/analytics-engine-staging.nomad.hcl
/usr/bin/nomad job plan     -var "image_tag=$TAG" deploy/analytics-engine-staging.nomad.hcl   # diff
/usr/bin/nomad job run -detach -var "image_tag=$TAG" deploy/analytics-engine-staging.nomad.hcl
/usr/bin/nomad job status analytics-engine-staging   # Latest Deployment = successful ?
```

Rollback : `nomad job revert <job> <version>` OU redéployer un `image_tag` antérieur.

> ⚠️ Un déploiement recrée le group (image change → `create/destroy update`), donc
> restart bref de clickhouse+postgres aussi (volumes bind persistants → données saines).
> C'est le comportement du job co-localisé, hérité de la migration. `nomad job plan` avant.

> ⚠️ Aligner ce HCL avec `~/nomad-veridian/jobs/analytics-engine*.nomad.hcl` (copie bastion)
> si l'infra édite le job à la main — ce repo est la source de vérité gitops.
