# 🟡 SSO autologin : exposer issue-token HMAC Hub + route /auth/token (Couche 1 contrat)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-22
> **Demandeur** : Robert
> **Statut** : ✅ **LIVRÉ côté engine + console** (2026-07-28, commit `00ea003`).
> Reste à faire : le Hub doit appeler `sso.issueToken` (ticket miroir
> `veridian-hub/todo/2026-06-22-brancher-analytics-au-broker-sso-autologin.md`).

## ✅ Ce qui a été livré le 2026-07-28

Routes réellement montées (les noms diffèrent du design ci-dessous, cf. écarts) :

- **`POST /api/sso.issueToken`** — `HubHmacGuard`, rend `{ autologin_url, expires_in }`
- **`POST /api/sso.exchange`** — public + throttle auth, rend `{ access_token, user, workspace_id }`
- **Page console `/sso`** — reçoit le jeton, l'échange, dépose le JWT en localStorage
- **Migration v13** `sso_login_tokens` + entrée dans `SYSTEM_SCHEMAS` (fresh installs)
- **`HUB_HMAC_SECRET`** ajouté au template *engine* des deux jobs Nomad (seul le
  bridge le recevait ; la variable existait déjà dans les deux Nomad vars)

### Trois écarts assumés par rapport au design figé ci-dessous

1. **Le jeton voyage dans le FRAGMENT (`/sso#<token>`), pas en query string
   (`?t=<token>`).** Un fragment n'est jamais transmis au serveur : il n'entre
   ni dans les logs d'accès, ni dans ceux du reverse-proxy, ni dans l'en-tête
   `Referer`. Avec `?t=`, chaque autologin aurait déposé un ouvre-session en
   clair dans des journaux conservés des mois, des deux côtés.

2. **La consommation est un `POST` depuis la page console, pas un `GET` qui pose
   un cookie.** La note du 2026-06-23 ci-dessous l'avait vu juste : l'auth de la
   console vit en localStorage, un cookie de session ne connecte personne.

3. **Table dédiée `sso_login_tokens`, pas de réutilisation de
   `password_reset_tokens`.** Un jeton de reset change un mot de passe, un jeton
   SSO ouvre une session : les séparer rend la confusion de type structurellement
   impossible entre les deux flux.

### Limite connue, documentée dans le code

ClickHouse n'offre pas de compare-and-swap : la consommation est un
read-then-write. Ferme le rejeu **séquentiel** (le cas réellement exploitable :
un jeton retrouvé dans un historique ou un log et rejoué plus tard), pas une
course strictement simultanée — qui n'apporte de toute façon aucun gain de
privilège, les deux sessions appartenant au même utilisateur. Le TTL de
2 minutes et le fragment d'URL tiennent dans tous les cas. Si ce résidu devient
inacceptable, le correctif propre est de sortir cette table de ClickHouse vers
un store à écriture conditionnelle, pas d'ajouter un verrou maison.

### Numéro de migration

Le registry était à **v12** (et non v9 comme l'écrivait la note de 2026-06-23) ;
la migration SSO est donc **v13**. La collision redoutée ne s'est pas produite,
les migrations v10 à v12 ayant été posées entre-temps.

### Note de nommage — à ne plus reperdre

Le secret HMAC porte **deux noms légitimes pour une même valeur** :
`HUB_HMAC_SECRET` côté engine et bridge, `ANALYTICS_HUB_API_SECRET` côté Hub.
Ce n'est pas une erreur du ticket. `HubHmacGuard` lit les deux, pour que l'app
démarre quelle que soit la convention employée au déploiement.

---

## Design figé d'origine (conservé pour mémoire — voir les écarts ci-dessus)

## ⚠️ Décision 2026-06-23 (sprint quick-wins) — NON CÂBLÉ ce sprint, ENV CONSERVÉE

Évalué pendant le sprint quick-wins. **Deux corrections de fond au ticket :**

1. **`HUB_HMAC_SECRET` n'est PAS une ENV morte.** Elle est activement consommée
   par le **bridge** (`veridian-bridge/src/index.ts:38`) pour le HMAC des routes
   `/api/tenants/*` (gate `compose/base.yml:151` `${HUB_HMAC_SECRET:?...}`). La
   retirer **casserait** l'auth tenants bridge↔Hub. → **ENV conservée.** Le ticket
   se trompait : "utilisé nulle part" ne vaut que pour l'**engine** (api/), pas
   pour le bridge.

2. **Le SSO autologin n'est PAS un quick win chirurgical.** C'est tier 🔴 HAUT et
   il est **incomplet par construction** sans deux autres chantiers hors de ce
   sprint :
   - **Côté engine** : nouvelle table ClickHouse `sso_login_tokens` + **migration
     sérialisée** (registry est à v9, deux agents parallèles posent v10/v11 ce
     sprint → collision de numéro de version garantie si on ajoute une migration ici).
   - **Côté console** : l'auth front est en **localStorage** (`console/src/lib/auth.tsx`,
     token `Bearer`), **PAS en cookie de session**. Un simple `GET /auth/token` engine
     qui pose un cookie ne connecte personne : il faut une **page console**
     `/auth/token` qui récupère le JWT et le met en localStorage. → chantier console.
   - **Côté Hub** : ticket miroir `veridian-hub/todo/2026-06-22-brancher-analytics-au-broker-sso-autologin.md`
     (autre repo / autre agent) — le SSO ne sert à rien tant que le Hub n'appelle
     pas issue-token.

   → Reporté à un sprint dédié SSO coordonné Hub+engine+console, pas mélangé à des
   quick wins de qualité. Aucune valeur livrée tant que les 3 côtés ne sont pas faits.

### Design figé (à exécuter quand priorisé, en un seul sprint coordonné)

- **Guard** : `HubHmacGuard` calqué sur `PlatformAdminGuard`
  (`api/src/admin-platform/guards/platform-admin.guard.ts`) — `timingSafeEqual`,
  lecture ENV double `ConfigService||process.env`, fail-closed. Vérifie
  `X-Hub-Signature` = HMAC-SHA256(`HUB_HMAC_SECRET`, `timestamp.body`) + fenêtre
  timestamp ±5 min (anti-replay).
- **Token** : réutiliser `generateToken()` + `createSession()` de
  `auth.service.ts` ; stocker le hash dans `sso_login_tokens`
  (ReplacingMergeTree, TTL 5 min, `consumed_at`). Usage unique.
- **Routes** : `POST /api/sso/issue-token` (HubHmacGuard) → `{ autologin_url }` ;
  `GET /auth/token?t=` (`@Public()`) → consomme, crée session, **renvoie le JWT
  à la page console** (pas un cookie) qui le pose en localStorage et redirige.
- **Pas d'énumération** d'email (404 générique sur issue-token).

Le reste du ticket ci-dessous décrit l'implémentation cible inchangée.

---

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
