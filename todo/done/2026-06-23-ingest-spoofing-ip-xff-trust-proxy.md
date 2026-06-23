# Spoofing IP / géo via `X-Forwarded-For` (pas de `trust proxy`)

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

`getClientIp` lit `cf-connecting-ip`, `x-real-ip`, puis le **premier** élément de
`x-forwarded-for` — tous **fournis par le client** — sans vérifier que la requête
provient bien du reverse-proxy de confiance. `main.ts` ne configure pas
`app.set('trust proxy', ...)`.

Un client en connexion directe peut envoyer `X-Forwarded-For: 1.2.3.4` pour se
géolocaliser dans le pays de son choix (la géo-résolution part de ce `clientIp`).
La géo est cosmétique aujourd'hui, MAIS : si le rate-limit infra par IP (ticket
`2026-06-23-ingest-track-aucun-ratelimit-dos.md`) se base sur cette IP, le
spoofing permet de contourner le bucketing → c'est un **pré-requis** à fixer avant
le rate-limit.

## Localisation (fichiers + lignes)

- `api/src/common/utils/ip.util.ts` — `getClientIp` (lit les headers client sans garde)
- `api/src/main.ts` — absence de `trust proxy` / liste d'IP proxy de confiance

## Correctif proposé

Ne faire confiance à `cf-connecting-ip` / `x-forwarded-for` QUE si la connexion
entrante provient des IP du reverse-proxy (Traefik/Cloudflare) — configurer
`trust proxy` avec la plage du proxy, ou valider `socket.remoteAddress` ∈ proxies
de confiance avant d'honorer les headers. Sinon retomber sur
`socket.remoteAddress`.

## Impact si non corrigé

Géo-données falsifiables à volonté ; et surtout, contournement du futur
rate-limit par IP. À traiter avant/avec le rate-limit infra.
