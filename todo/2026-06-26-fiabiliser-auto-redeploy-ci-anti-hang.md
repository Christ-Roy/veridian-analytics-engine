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

## Fait — prod-ci.yml Option A (GO Robert 2026-06-26, tier 🔴)

Commit `ci(prod): SSH keepalive + timeout pre-pull anti-hang` :
- `~/.ssh/config` keepalive sur les 3 SSH (trigger, health-check, rollback).
- `timeout 300 docker pull … || warning` sur les 2 pre-pull (non bloquant :
  `compose.deploy` Dokploy re-pull au up ; le verdict gitSha tranche).
- On GARDE merge-env `compose.update` + `wait-dokploy-deploy.sh` (verdict
  gitSha loopback) — inchangés, c'est le bon design.

Options écartées (pour A) :
- B (tout HTTPS direct comme Prospection) — voir chantier dédié ci-dessous.
- C (poll health public, abandon verdict loopback) : régression fiabilité. ~5%.

## À ÉPROUVER

Un workflow ne se prouve qu'au prochain run. Le durcissement staging est
validé par le run CI de ce commit (deploy-staging vert). Le prod-ci Option A
ne sera prouvé **qu'au prochain deploy prod réel** après merge main : si un hang
réapparaît, le SSH coupe désormais à ~60s et le pull à 300s → échec net +
rollback auto, plus de silence 19 min.

## Chantier FUTUR (créneau dédié, pas en urgence) — migrer vers HTTPS Dokploy direct

Pattern Prospection = le plus robuste : `curl https://dokploy.veridian.site/api/
compose.deploy` (x-api-key, **zéro SSH**) → élimine la cause RACINE du hang
(plus de tunnel SSH du tout), pas juste la borne. Migrer staging+prod engine
vers ce pattern quand on aura un créneau posé. Subtilité engine : le verdict
gitSha loopback (`wait-dokploy-deploy.sh`, `docker exec` dans le container) a
besoin d'UN accès VPS — soit garder 1 SSH durci pour le seul verdict, soit
exposer un endpoint de verdict. À designer.

**MÊME BUG CHEZ Hub + CMS** (SSH → docker pull non borné, identique à l'incident
engine 2026-06-25). À router vers leurs agents dédiés (déposer un `todo/` dans
veridian-hub + veridian-cms). Pas encore touchés par le hang mais même bombe.

## Dette infra transverse — dev-pub disque 94 %

- 4.9G libres après nettoyage `/tmp` (~1G build/test : eng-templates, jest_rs,
  node-compile-cache). Suffisant pour un `compose pull` staging — **pas bloquant**.
- `/var/lib/docker` = 19G (17 images actives, 22 containers, 0 dangling, builder
  cache 0B → rien de plus à gratter côté docker sans risque).
- Reste = checkouts des autres apps + volumes staging actifs → **PAS safe à
  purger de notre côté** (multi-agents). Purge profonde + "qui possède quoi sur
  dev-pub" à arbitrer par Robert. Dette transverse, non bloquante.
