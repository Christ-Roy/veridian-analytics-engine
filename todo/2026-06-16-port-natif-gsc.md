# Port natif GSC (Search Console) — décision A vs B avant decommission bridge

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-16
> **Auteur audit** : agent audit-gsc-voip (Lot C, sprint decommission)
> **Statut** : DÉCISION REQUISE (Robert tranche A vs B) — PAS d'exécution avant GO

---

## 1. État actuel (cartographie code)

GSC est **100 % dans le bridge Express** (`veridian-bridge/src/gsc/`). 5 fichiers :

| Fichier | Rôle |
|---|---|
| `oauth.ts` | Flow OAuth Google (consent → code → tokens). Tokens `access_token`+`refresh_token` chiffrés AES-256-GCM (clé globale `TOKEN_ENCRYPTION_KEY`) et stockés dans `GscProperty.oauthAccount` (Postgres-bridge). Refresh automatique avant expiration. State anti-CSRF HMAC. |
| `sync.ts` | Pull GSC API `searchAnalytics.query` (dims date/query/page/country/device), backoff 429/5xx, persiste dans table Postgres `GscDaily`. `syncAllVerified` = batch tous les tenants `verified`. |
| `query.ts` | Query DSL maison (SQL brut sur `GscDaily`) : totals, topQueries, topPages, timeseries. Reproduit la shape de l'API GSC en lecture depuis la DB. |
| `routes.ts` | 5 endpoints Express admin : `oauth-begin`, `oauth-callback`, `sync`, `sync-all` (cron), `GET /tenant/:wsId/gsc` (dashboard). |
| `index.ts` | Barrel + `oauthCallback` high-level. |

**Où la data atterrit** : Postgres-bridge (`GscProperty` + `GscDaily`), **PAS ClickHouse**. C'est de la donnée relationnelle agrégée, pas des events de tracking.

**Ce que la console consomme** : `console/src/veridian/settings-panels/search-console-panel.tsx` (onglet Settings `search-console`, conforme vision — pas de page dédiée) + `console/src/veridian/gsc/*` (api.ts, performance-dashboard, kpi-tile, time-series-chart, data-table). La console fetch **`GET {bridge}/api/admin/tenant/:wsId/gsc?days=N`** avec Bearer admin. **Dépendance dure au bridge.**

**Déclenchement sync** : GitHub Action `.github/workflows/gsc-sync-cron.yml` → POST `/api/admin/gsc/sync-all`. **Cron DÉSACTIVÉ** (`if: vars.GSC_SYNC_ENABLED == 'true'`, schedule commenté). En prod, **GSC ne sync donc pas automatiquement aujourd'hui** — la data n'est rafraîchie que si on déclenche le workflow_dispatch à la main (ou s'il a été activé manuellement via la repo var).

## 2. La question : GSC rentre-t-il dans le modèle event staminads natif ?

**NON.** GSC n'est pas un flux d'events de tracking. C'est :
- de la donnée **agrégée externe** (clicks/impressions/position par query×page×jour),
- qui exige un **OAuth long-vécu** (refresh tokens chiffrés persistés),
- un **cron de sync** pull-based,
- une **query analytique relationnelle** (group by, filtres, totals pondérés).

Le moteur staminads pur ingère des events via `/api/track` → ClickHouse. Forcer GSC dans ce modèle (pousser chaque row GSC comme un "event") serait un abus : on perdrait la sémantique (position moyenne pondérée, CTR, dédup par dimension) et on polluerait Live/Explore avec des pseudo-events non-comportementaux. **Contrairement au VoIP** (cf [[2026-06-16-port-natif-voip]]) qui EST un event ponctuel `phone_call`, GSC est une time-series analytique → ça ne se mappe pas sur le modèle event.

**Conclusion** : GSC ne peut PAS être "porté natif" au sens "devient des events staminads". La vraie question est : **où vit la couche d'intégration GSC** (OAuth + cron + table + query) — dans un module NestJS de l'engine, ou elle reste dans un service séparé ?

## 3. Options

### Option A — Module NestJS natif `gsc/` dans l'engine (RECO)

Porter la logique bridge dans un module NestJS `api/src/gsc/` :
- **OAuth** : réutiliser `common/crypto.ts` natif (AES-256-GCM **avec clé dérivée par workspace** via PBKDF2 — *plus sûr que la clé globale du bridge*). Tokens stockés dans Postgres engine (nouvelle table `gsc_property` via migration TypeORM/Prisma engine).
- **Cron** : `@Cron()` natif via `ScheduleModule` **déjà importé** dans `app.module.ts` (cf `subscriptions/scheduler/subscription-scheduler.service.ts` qui tourne en `@Cron('0 */15 * * * *')`). Zéro GitHub Action externe à maintenir.
- **Query** : endpoint NestJS `GET /api/gsc/dashboard?workspace_id=...` authentifié par la **vraie auth engine** (API key workspace / session), pas par un Bearer admin global.
- **Console** : repointer `console/src/veridian/gsc/api.ts` de `{bridge}/api/admin/tenant/:ws/gsc` vers `{engine}/api/gsc/dashboard`. Les composants UI (dashboard, kpi-tile, charts) **ne changent pas** (même shape de réponse).

**Avantages** :
- Plus de bridge pour GSC → débloque le Lot E (decommission bridge).
- Auth propre (clé workspace, pas Bearer admin global qui voit tous les tenants).
- Crypto par-workspace (rotation/isolation possible).
- Cron natif observable (logs engine, pas une GH Action gated qui ne tourne pas).
- Un seul déploiement (engine), une seule DB.

**Inconvénients** :
- L'engine est un **fork staminads (AGPL)** : ajouter un module métier Veridian dans le fork. Acceptable — c'est déjà le cas pour `webhooks/connectors/twenty-*` (connecteur natif Twenty) et `demo/`. Le pattern "module Veridian dans l'engine" est établi.
- Migration DB engine (nouvelle table GSC) + migration de la data existante `GscDaily` bridge → engine (ou re-sync from scratch via OAuth, plus simple : la data GSC se re-pull en 1 sync).
- Effort réel (voir §4).

### Option B — Couche d'intégration séparée documentée (micro-service GSC)

Extraire `gsc/` du bridge mort vers un **micro-service GSC autonome** (le bridge meurt, mais GSC survit comme service dédié), gardant l'archi pull→Postgres→query mais sans le reste du bridge.

**Avantages** :
- Isole la dette : l'AGPL de l'engine reste "pur staminads + connecteurs", le métier Veridian (OAuth Google, sync) vit dehors.
- Moins de risque sur l'engine (pas de migration de son schéma).

**Inconvénients** :
- On recrée **exactement le problème qu'on veut tuer** : un service Express séparé avec sa DB Postgres, son cron, son auth Bearer admin maison. C'est le bridge sous un autre nom. **Contraire à la règle d'or "arrêter le bricolage / propre first"** (CLAUDE.md racine).
- 2 backends à déployer/monitorer/sécuriser au lieu d'1.
- L'auth reste un Bearer admin global (anti-pattern, cf Lot B).

## 4. Recommandation chiffrée

**Option A — module NestJS natif `gsc/` — à ~80 %.**

Raison business : GSC est un **bonus SEO** (3e feature commercialisable, la moins critique). Le porter natif dans l'engine élimine définitivement le bridge pour cette feature, donne une auth propre, et bénéficie gratuitement du scheduler + crypto natifs déjà présents. L'argument AGPL (B) ne tient pas : le pattern "module Veridian dans le fork" est déjà acté (connecteur Twenty natif). Refaire un micro-service séparé = recréer le bridge = exactement ce que Robert veut arrêter.

Le 20 % restant pour B : si Robert veut garder l'engine 100 % "staminads upstream-mergeable" (faciliter les rebase sur staminads amont). Mais vu qu'on a déjà divergé (connecteurs, demo, mail FR), ce bateau est parti.

**Effort estimé Option A** : ~2 à 3 jours dev (1 agent Opus) :
- Module NestJS `gsc/` (controller + service + oauth service + sync cron) : ~1j
- Migration schéma engine (table gsc_property) + crypto par-workspace : ~0,5j
- Repointage console + tests E2E (OAuth flow simulé + sync + dashboard) : ~0,5j
- Migration data existante OU re-sync (5 clients max) : ~0,5j

## 5. Risques

- **OAuth redirect URI** : le `redirect_uri` Google est déclaré côté Google Cloud Console (`veridian-preprod`). Changer le host du callback (bridge → engine) = mettre à jour les URIs autorisées chez Google AVANT bascule. Coordination Hub possible si l'OAuth Google est partagé.
- **Migration data** : `GscDaily` contient l'historique. Re-sync from scratch ne récupère que ~16 mois max (limite API GSC) — acceptable, on perd peu. Sinon dump/restore Postgres-bridge → engine.
- **Clé de chiffrement** : les tokens bridge sont chiffrés avec `TOKEN_ENCRYPTION_KEY` (clé globale). Migration crypto = déchiffrer côté bridge, re-chiffrer côté engine (clé dérivée workspace). Ou plus simple : re-consent OAuth (5 clients, quelques clics).

## 6. DoD (Option A)

- [ ] Module `api/src/gsc/` : OAuth service + sync service (`@Cron`) + controller (`GET /api/gsc/dashboard`).
- [ ] Migration schéma engine : table `gsc_property` (tokens chiffrés via `common/crypto.ts` clé-par-workspace) + table/structure pour les rows daily (ou agrégation directe).
- [ ] Auth : endpoint protégé par auth engine native (clé workspace), PAS Bearer admin global.
- [ ] Cron natif `@Cron` enregistré, observable dans les logs engine. GH Action `gsc-sync-cron.yml` supprimée.
- [ ] Console repointée (`gsc/api.ts` → engine), composants UI inchangés, onglet Settings `search-console` fonctionnel sur staging.
- [ ] 5 clients re-consentés OU data migrée ; dashboard GSC affiche la data sur staging.
- [ ] Redirect URI Google mise à jour (host engine).
- [ ] Tests : OAuth flow (state HMAC, exchange, refresh), sync (backoff, upsert idempotent), query (totals pondérés). E2E staging vert.
- [ ] Code GSC supprimé du bridge (`veridian-bridge/src/gsc/`) — débloque Lot E.

## 7. Dépendance decommission (Lot E)

🔴 **GSC natif (A) ou couche propre (B) DOIT être livré et la console repointée AVANT de couper le bridge.** Tant que `search-console-panel.tsx` fetch `{bridge}/api/admin/tenant/:ws/gsc`, couper le bridge = casser l'onglet Search Console des 5 clients. Ordre :
1. Port GSC (A) livré + testé staging
2. Console repointée engine + E2E vert
3. Bridge GSC routes mortes (plus aucun appel)
4. → Lot E peut couper le bridge

Voir aussi [[2026-06-16-port-natif-voip]] (même contrainte d'ordre).
