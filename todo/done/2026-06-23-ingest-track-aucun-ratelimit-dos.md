# `/api/track` sans aucun rate-limit (ni applicatif ni infra) — DoS / pollution

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

`POST /api/track` est `@Public()` ET `@SkipRateLimit()` au niveau classe
(`events.controller.ts:9,17`). Le skip est **total** (les 3 throttlers nommés
sont court-circuités). Le skip applicatif est **défendable** (des millions
d'appareils derrière un même IP NAT partagent l'IP), MAIS il n'y a **aucun filet
en aval** :

- `compose.yaml` / `compose/prod.yml` : **aucun** middleware Traefik `ratelimit`,
  aucun label de limitation sur le router `/api/track`.
- Aucune mention de WAF / Cloudflare rate-limit dans le repo.

Donc zéro limitation de débit sur l'endpoint le plus exposé. Une seule IP peut
envoyer des milliers de req/s ; chaque requête déclenche un lookup workspace
(caché 60s), un buffer, un flush ClickHouse et un fan-out webhook par event.

Atténuant réel : le body est cappé à 100kb (défaut Express, non surchargé) et
`ArrayMaxSize(1000)` borne le coût PAR requête. Mais le NOMBRE de requêtes n'est
pas borné.

## Localisation (fichiers + lignes)

- `api/src/events/events.controller.ts:9` (`@SkipRateLimit()`), `:17` (`@Public()`)
- `api/src/common/decorators/throttle.decorator.ts` — skip explicite des throttlers
- `compose.yaml`, `compose/prod.yml` — absence de middleware Traefik ratelimit

## Correctif proposé

Ajouter un rate-limit **au niveau infra** (le bon endroit pour un endpoint
public à fort volume) : middleware Traefik `ratelimit` généreux par IP source
sur le router qui sert `/api/track` (ex. burst 50/s, average 20/s par IP), OU
s'appuyer sur Cloudflare si le domaine y passe. Le câbler dans
`compose/prod.yml` (labels Traefik) + `compose/staging.yml`.

⚠️ PRÉ-REQUIS : fixer d'abord le spoofing IP (ticket
`2026-06-23-ingest-spoofing-ip-xff-trust-proxy.md`), sinon le bucketing par IP
du rate-limit est trivialement contournable via `X-Forwarded-For`.

## Impact si non corrigé

DoS applicatif trivial (amplification ClickHouse + webhooks) et pollution de
données par volume. Endpoint critique non protégé.
