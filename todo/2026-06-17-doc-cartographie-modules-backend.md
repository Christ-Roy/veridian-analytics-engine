# Documenter la cartographie réelle des modules backend (parité doc↔code)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : DOCUMENTER (doc absente, code actif)
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié)

`api/src/app.module.ts` câble **26 modules** NestJS. Le `CLAUDE.md` du repo et
`VERIDIAN-README.md` ne décrivent l'engine que comme un bloc générique
(« NestJS + ClickHouse + AI assistant »). **Aucune cartographie des modules
réels** n'existe — un nouvel agent qui arrive sur le repo ne sait pas, sans
lire le code, ce qui est actif, dormant, ou hors-scope.

Modules présents (`api/src/`), tous importés dans `app.module.ts:96-122` :

| Module | Routes exposées | Statut réel (vérifié) | Documenté ? |
|---|---|---|---|
| analytics | `analytics.query/.extremes/.metrics/.dimensions/.tables` | actif (cœur) | partiel (ANALYTICS_REFERENCE) |
| events | `POST track` (public) | actif (cœur) | partiel (EVENTS-CUSTOM) |
| voip | `voip.*` (settings + numéros + sync) | actif (feature Veridian) | ✅ (récent, port natif) |
| gsc | `gsc/*` (dashboard/oauth/resync) | actif (feature Veridian) | ✅ (récent, port natif) |
| tunnel | `tunnel.aggregate` | actif (réconciliateur identité cross-app) | ✅ (TUNNEL-IDENTITE) |
| admin-platform | `admin/platform/tenants.provision`, etc. | actif (M2M Hub) | ✅ (PLATFORM-ADMIN-API) |
| webhooks | 9 routes (CRUD + deliveries + test + events) | actif backend, **0 UI** | ⚠️ todo/PATTERNS-WEBHOOKS uniquement |
| **assistant** | `assistant.chat`, `assistant.stream/:jobId` | **dormant** (clé Anthropic jamais câblée, hors scope) | ❌ |
| **audit** | `audit.list`, `audit.getByTarget` | **alimenté** (auth/members/subscriptions) mais **0 UI** | ❌ |
| **export** | `export.userEvents` | actif (consommé par tunnel) | ❌ |
| **subscriptions** | rapports email programmés + cron | **dormant si SMTP absent**, hors scope | ❌ |
| **tools** | `tools.websiteMeta`, `tools.favicon` (publics) | actif (détection logo) — **trou SSRF, cf ticket dédié** | ❌ |
| mail + smtp | `smtp.*` | infra partagée, dormant global si `SMTP_HOST` vide | partiel (onglet Settings) |
| invitations | `invitations.*` | actif si SMTP — flow membre intra-workspace (≠ M2M) | ❌ |
| members / api-keys / filters / subscriptions / workspaces / users / auth / setup / demo / sdk / health / common / database | natifs staminads | actifs | implicite |

**Preuves** :
- App module : `api/src/app.module.ts:10-122` (liste complète des imports).
- Audit alimenté : `api/src/auth/auth.service.ts:212,290`,
  `api/src/members/members.service.ts:198,288,329,397`,
  `api/src/subscriptions/subscriptions.controller.ts:85-333` (actions loggées).
- Export consommé par tunnel : `api/src/tunnel/tunnel-aggregate.service.ts`
  réutilise `ExportService.getUserEvents`.
- Assistant dormant : aucune ENV `ANTHROPIC*` ni `ASSISTANT_THINKING*` dans
  `compose/base.yml` / `compose/prod.yml` / `compose-demo.yaml` ; clé stockée
  par workspace chiffrée, jamais posée (`api/src/assistant/assistant.service.ts:111-115`).

## Demande précise

Ajouter dans `CLAUDE.md` (section « Architecture two-tier » ou annexe) **un
tableau de cartographie des modules backend** avec, pour chacun : rôle 1 ligne
+ statut (actif Veridian / actif staminads conservé / dormant / hors-scope) +
surface (UI / API-only / cron / cross-app). C'est exactement ce tableau
ci-dessus, à maintenir.

Objectif : qu'un agent sache en 2 min ce qui est vivant, sans relire 26 modules.

## Impact

Sans ça : risque récurrent qu'un agent (1) re-développe une capacité native
existante (assistant, export, audit) faute de la connaître, ou (2) investisse
sur un module dormant/hors-scope en croyant qu'il est commercialisé. Plusieurs
des autres tickets de cet audit découlent directement de cette absence de
cartographie.

## Liens

- Ticket arbitrage assistant IA : `2026-06-17-arbitrer-assistant-ia-hors-scope.md`
- Ticket arbitrage subscriptions : `2026-06-17-arbitrer-subscriptions-rapports-email.md`
- Ticket webhooks doc/UI : `2026-06-17-webhooks-orphelin-ui-doc.md`
- Ticket SSRF tools : `2026-06-17-secu-ssrf-tools-endpoints-publics.md`
