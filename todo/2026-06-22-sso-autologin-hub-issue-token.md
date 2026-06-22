# 🟡 SSO autologin : exposer issue-token HMAC Hub + route /auth/token (Couche 1 contrat)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-22
> **Demandeur** : Robert

## Demande

Implémenter la **Couche 1 (Hub broker)** du contrat SSO (`CONTRAT-HUB.md §6bis.1`)
pour que le Hub puisse connecter automatiquement un user sur le dashboard analytics
sans re-saisie. Aujourd'hui **rien n'est câblé** : `HUB_HMAC_SECRET` est dans l'ENV
Dokploy engine prod mais **utilisé nulle part dans le code** (vérifié 2026-06-22).

## À implémenter (engine)

1. **`POST /api/sso/issue-token`** — authentifié **HMAC `HUB_HMAC_SECRET`** (pattern
   §6.1 : header signature + timestamp, anti-replay, timing-safe ; s'inspirer du
   guard HMAC existant si présent, sinon créer un `HubHmacGuard`).
   - Body : `{ email }` (ou `{ hub_user_id, email }`).
   - Résout le user par email → s'il existe et a au moins un workspace, génère un
     **token autologin** court (TTL ~5 min, usage unique, stocké hashé — réutiliser
     le pattern `generateToken()` de `common/crypto.ts` + une table type
     `sso_login_tokens` ReplacingMergeTree, ou réutiliser `password_reset_token`
     avec un type distinct).
   - Réponse : `{ autologin_url: "https://analytics-engine.app.veridian.site/auth/token?t=<token>" }`.
   - Si email inconnu → 404 (pas d'énumération : message générique).

2. **`GET /auth/token?t=<token>`** — `@Public()`. Consomme le token (vérifie hash +
   TTL + non consommé), crée une session (même mécanisme que `auth.login` :
   access_token JWT + cookie), marque le token consommé, redirige `302` vers le
   dashboard (`/` ou `/workspaces/<premier_ws>`).

## Sécurité
- Token : usage unique, TTL court, stocké **hashé** (jamais en clair en DB).
- HMAC : timing-safe, fenêtre timestamp courte (anti-replay), `HUB_HMAC_SECRET`
  lu depuis l'ENV (déjà présent).
- `/auth/token` ne doit pas être bruteforçable (token = 32 bytes random).
- Pas d'énumération d'email sur issue-token.

## Migration
Probable : 1 table `sso_login_tokens` (ou réutiliser password_reset). **Additive**
(ADD TABLE) → migrate-on-boot, sérialiser le numéro de version avec les autres
migrations en cours.

## Côté Hub (ticket miroir déposé)
`veridian-hub/todo/2026-06-22-brancher-analytics-au-broker-sso-autologin.md` :
le Hub appelle issue-token en HMAC et redirige vers l'autologin_url au clic
« Open Analytics ».

## Contexte
Workspace de Robert = `vrd_veridian_site_prod`, owner `robert.brunon@veridian.site`
(super_admin, créé 2026-06-22). Contrat complet : `CONTRAT-HUB.md §6bis`.
