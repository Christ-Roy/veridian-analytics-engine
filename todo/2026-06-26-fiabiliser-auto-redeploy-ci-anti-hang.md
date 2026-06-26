# Fiabiliser l'auto-redeploy CI (anti-hang SSH) — staging + prod

> **Sévérité** : 🟡 P1
> **Owner** : agent infra (analytics-engine)
> **Créé** : 2026-06-26

## Contexte / incident

Le deploy engine se fait par SSH (dev-pub pour staging, prod-pub pour prod)
puis `docker compose` / API Dokploy. Deux symptômes :

1. **Prod 2026-06-25 20:08→20:27** : job "Deploy prod (Dokploy API)" a fait
   `Download complete` (docker pull) puis **19 min de SILENCE** sur le process
   SSH → cancelled à 20 min (timeout job). HANG SSH MUET. L'image était sur
   GHCR, prod restée sur l'ancien tag. Rerun a débloqué.
2. Doute staging sur le tag `${ENGINE_IMAGE_TAG}` — vérifié OK (tag déterministe
   `staging-<sha7>` écrit explicitement dans `.env` avant le `up`).

Cause racine du hang : aucun `ConnectTimeout`/`ServerAliveInterval` sur les SSH,
aucun `timeout` autour du `docker pull`. Un pull figé pend sans borne.

## Audit autres apps (2026-06-26)

- **Hub** (réf) + **CMS** : SSH prod-pub → curl `compose.deploy` tRPC localhost.
  Même `docker pull` non borné → MÊME risque de hang, pas encore tombé dessus.
- **Prospection** : API Dokploy **HTTPS directe** (`dokploy.veridian.site/api/
  compose.deploy`, x-api-key, ZÉRO SSH) + poll `/api/version` `--max-time 5`.
  Pattern le plus robuste (pas de tunnel SSH = pas de hang SSH).
- **Engine (nous)** : a DÉJÀ le meilleur verdict post-deploy de la flotte —
  `wait-dokploy-deploy.sh` confirme `/api/health.gitSha == SHA déployé` en
  loopback dans le container (bypass Traefik/DNS). Manquait juste le bornage SSH.

## Fait (livré sur staging, commit `ci(staging): SSH keepalive + timeout…`)

`staging-deploy.yml` durci (3 jobs : deploy-staging, e2e-staging-smoke,
rollback-staging) :
- `~/.ssh/config` avec `ConnectTimeout 15` + `ServerAliveInterval 15` +
  `ServerAliveCountMax 4` (60s sans octet → coupe).
- `timeout 300 docker compose … pull` + `timeout 240 … up` (deploy + rollback).
- Un hang échoue désormais en < 3 min au lieu de pendre 18 min. Rollback auto
  (étage 5) prend le relais.

## En attente go Robert — prod-ci.yml (tier CI critique)

**Option A retenue (reco ~75%)** — diff prêt dans le worktree, NON commité :
- `~/.ssh/config` keepalive sur les 3 SSH (trigger, health-check, rollback).
- `timeout 300 docker pull … || warning` sur les 2 pre-pull (non bloquant :
  `compose.deploy` Dokploy re-pull au up ; le verdict gitSha tranche).
- On GARDE merge-env `compose.update` + `wait-dokploy-deploy.sh` (verdict
  gitSha loopback) — inchangés, c'est le bon design.

Options écartées :
- B (tout HTTPS direct comme Prospection) : élimine la cause racine mais
  réécrit ~40 lignes + garde quand même 1 SSH pour le verdict loopback. ~20%.
- C (poll health public, abandon verdict loopback) : régression fiabilité. ~5%.

## À ÉPROUVER

Un workflow ne se prouve qu'au prochain run. Le durcissement staging est
validé par le run CI de ce commit (deploy-staging vert). Le prod-ci Option A
ne sera prouvé qu'au prochain deploy prod après merge main.

## Alerte infra connexe

**dev-pub disque à 94 %** (4.9G libre après nettoyage `/tmp` ~1G). Un
`compose pull` staging (image ~500MB-1G) peut échouer si ça remplit. `/var/lib
/docker` = 19G (actif, peu de reclaimable, 0 dangling). Surveillance / purge
plus profonde à prévoir (décision Robert : que garder).
