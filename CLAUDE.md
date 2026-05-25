# Veridian Analytics Engine — Instructions agent

> Fork interne de **staminads** v6.1.0, branché Veridian SaaS multi-tenant.
> URLs : staging `analytics-engine.staging.veridian.site` (branche `staging`),
> prod `analytics-engine.app.veridian.site` (branche `main`).
> Bridge Veridian : `veridian-bridge/` (Express + Postgres) côté tenants/auth,
> engine staminads = NestJS + ClickHouse côté analytics.

---

## 🎯 VISION COMMERCIALISATION — figée 2026-05-25 par Robert

> Cette section est la **source de vérité scope** pour cet engine.
> Lecture **obligatoire** avant tout ticket touchant à l'app, l'UI, le bridge,
> le provisioning ou les intégrations externes.
> Toute proposition contradictoire = remonter à Robert AVANT d'agir.
> Cohérent avec la vision legacy figée 2026-05-23 dans
> `~/Bureau/veridian-platform/veridian-analytics/CLAUDE.md`.

### Les 3 features visibles client — et c'est TOUT

1. **Visiteurs uniques + analytics natif staminads** — dashboard
   `/workspaces/$wsId/` et toutes les pages staminads vanille (Live, Explore,
   Goals, Filters, Annotations, Settings). On NE refait PAS ce que staminads
   fait déjà bien.

2. **Calls — tracking téléphone par source de trafic** (LA vraie valeur
   différenciante Veridian) :
   - Provider actuel : **OVH téléphonie**. Migration future vers un **CPaaS
     moderne** (Telnyx pressenti, Robert tranchera plus tard) → l'archi
     bridge doit rester pluggable provider-agnostic.
   - Pattern fondateur : **1 numéro par source de trafic**. Le site SEO
     affiche un numéro X, les annonces Google Ads affichent un numéro Y, une
     fiche Google Business affiche un Z, un flyer papier affiche un W, etc.
   - Quand un appel arrive sur X / Y / Z / W → le bridge push un event
     `phone_call` natif staminads via `/api/track`, avec une dimension
     `source` (`seo` / `ads` / `gmb` / `flyer` / `direct` / …) et une
     dimension `phone_number_e164` pour l'audit.
   - Du coup les appels apparaissent **automatiquement** dans Live, Explore,
     Goals, Annotations — **pas une seule page UI custom à coder**. C'est
     juste un type d'event de plus dans le pipeline staminads natif.
   - Connexion provider = **onglet dans Settings**, pas page dédiée
     (cf §"UI intouchée" ci-dessous).

3. **Search Console — bonus SEO** : connecter Google Search Console dans
   **Settings → onglet Search Console** (PAS de page dédiée). Le panel
   Settings affiche tout en dense : OAuth connect, statut, mots-clés top,
   pages top, ranking, mini-graphe time-series, indexation. **C'est la SEULE
   place où GSC vit** — Settings = dashboard + config en un seul panel.

**Et c'est tout.** Le scope commercial V1 tient en ces 3 features.

### Pourquoi PAS de tracking Google Ads natif dans l'app

Robert le 2026-05-25 : *"la méthode numéros différents suffit pour attribuer"*.

- ❌ Pas d'intégration `googleads` API dans le bridge
- ❌ Pas de page "Ads campaigns" dans la console
- ❌ Pas de pull conversions Google Ads → staminads
- ❌ Pas d'OAuth Google Ads dans Settings

**Pourquoi** : le pattern "1 numéro = 1 source" résout l'attribution à la
racine. Si un appel arrive sur le numéro Ads, c'est par définition une
conversion Ads — pas besoin de croiser avec l'API Google Ads, c'est de la
data first-party côté Veridian. Plus simple, plus fiable, plus respectueux
de la vie privée, zéro dépendance Google.

Si plus tard un client demande explicitement le push des conversions vers
Google Ads (pour smart bidding), on l'ajoutera **côté Hub** comme service
optionnel, pas dans l'engine. L'engine reste centré sur l'analytics
first-party.

### Provisioning client = skill `analytics-provision`, jamais UI

**Workflow cible** : un agent assistant Veridian (Hub ou Robert) provisionne
un nouveau client via le skill **`analytics-provision`** (existe déjà côté
local — actuellement désynchronisé, pointe encore sur le repo legacy
`veridian-analytics`, à recâbler vers cet engine).

Un seul call API M2M doit suffire à :
1. Créer le **tenant** dans le bridge Postgres
2. Créer le **workspace** staminads associé (1 tenant = 1 workspace en V1)
3. Créer le **user** propriétaire (le client final)
4. Renvoyer l'**API key** workspace pour brancher le snippet SDK sur le site
5. Envoyer un **email d'invitation magic link** au prospect (via le bridge
   ou Hub → Notifuse, à arbitrer)
6. Pré-provisionner les **numéros tracking** souhaités (un par source) côté
   provider téléphonie, et câbler les webhooks vers le bridge

**Conséquences strictes** :
- ❌ AUCUNE page admin UI dans `console/src/routes/_authenticated/admin/*`
- ❌ AUCUN onglet "New tenant" dans Settings
- ❌ AUCUNE route `console/src/routes/_authenticated/workspaces/new.tsx`
  custom au-delà du onboarding staminads natif
- ✅ Tout passe par des endpoints **API M2M** côté bridge
  (`POST /api/admin/provision`, HMAC ou JWT M2M)
- ✅ Le skill consomme ces endpoints, retourne snippet + magic link à
  Robert / Hub
- ✅ La page d'onboarding `welcome.tsx` existante reste tolérée (workflow
  user end), minimaliste

**Ticket Hub à venir** : Hub doit savoir provisionner cet engine de la même
manière qu'il provisionne déjà Notifuse et Prospection (pattern uniforme
`POST /api/<app>/provision` côté chaque app downstream). Doit aussi savoir
**pré-créer le tenant avant que le prospect s'inscrive** côté Hub (cas
où Robert vend en amont, le prospect reçoit le magic link, signup Hub +
attache au tenant existant).

À créer : ticket dans `~/Bureau/veridian-platform/veridian-hub/todo/` pour
câbler cette intégration. Cet engine doit publier un contrat clair de
l'endpoint `POST /api/admin/provision` (input + output + auth) que Hub
consommera.

### UI intouchée — règle d'architecture stricte (rappel)

Robert 2026-05-23 (toujours en vigueur) : *"les features Veridian doivent
être proprement mises dans l'UI de base pas dans des pages à part — à la
rigueur on peut avoir des onglets dans settings liés aux features mais
c'est tout"*.

**Conséquences pour cet engine** :
- ❌ AUCUNE sous-route dédiée Veridian dans
  `console/src/routes/_authenticated/workspaces/$workspaceId/*`
  (PAS de `calls.tsx`, PAS de `search-console.tsx`, PAS de `veridian.tsx`,
  PAS de `ads.tsx`, etc.)
- ❌ AUCUN lien dans la nav latérale staminads pointant sur du custom
  Veridian
- ❌ AUCUN composant "hero Veridian" qui dénature le dashboard staminads
- ✅ SEULES extensions autorisées :
  - **Onglets/sections dans Settings** (extension du `z.enum` `section`
    côté `console/src/routes/_authenticated/workspaces/$workspaceId/settings/$section.tsx`
    — refonte UI native pure mergée 2026-05-24, PR #28)
  - **Events staminads custom** (le bridge pousse des events dans
    `staminads.events` → s'affichent automatiquement dans Live / Explore /
    Goals / Annotations sans code UI custom)
  - **Page onboarding** (`welcome.tsx`) — exception tolérée car workflow
    user, reste minimaliste

Si un futur agent propose de créer une sous-route Veridian dédiée → **erreur,
le reprendre**. Lui rappeler cette règle.

### Langue : français par défaut

L'app est **commercialisée en France pour des clients français**. Toute la
console est en **français** (in-place, pas de système i18n) :
- HTML `lang="fr"`
- Vouvoiement par défaut
- Accents préservés (à, é, è, ç, ô, ï…)
- Anglicismes acceptés uniquement pour noms propres (Analytics, Search
  Console, GSC, URL, API, HMAC, ClickHouse, NestJS…)
- Format date `dd/MM/yyyy HH:mm`, virgule décimale française pour les
  chiffres

**Pas de toggle EN/FR dans l'UI** (KISS). Si vente internationale plus tard,
on ajoute un setup i18n à ce moment-là — pas avant.

`feat/french-i18n` mergé sur staging au commit `c1ffce2` (2026-05-24).

### Anti-régression : ce qui ne doit PAS être ajouté

Robert a explicitement formulé cette vision le 2026-05-25 après audit du
sprint giga sur le repo legacy. Si un futur agent re-porte une de ces
features parce qu'il trouve une trace dans la doc, le legacy ou un ancien
ticket → **erreur**.

| Tentation | Réponse |
|---|---|
| Créer une page admin UI pour provisionner des tenants | ❌ NON — tout passe par skill `analytics-provision` + API M2M |
| Intégrer l'API Google Ads (campagnes, conversions, smart bidding) | ❌ NON — numéros différents suffisent pour attribuer ; éventuel push conversions = côté Hub plus tard, pas engine |
| Ajouter un toggle EN/FR dans Settings ou la navbar | ❌ NON — français only, KISS |
| Créer une sous-route `workspaces/$wsId/calls` ou `workspaces/$wsId/ads` | ❌ NON — events natifs staminads + onglets Settings, point |
| Afficher du pricing / des limites / un compteur visible côté client | ❌ NON — l'app ne doit JAMAIS être défigurée par des limites visibles (cf §"Pricing & trial cross-app" racine `veridian-platform/CLAUDE.md`) |
| Réintroduire le "Score Veridian global", "shadow marketing blocks", "locked service page" | ❌ NON — features explicitement débranchées 2026-05-23, parking permanent |
| Ajouter Forms ingestion + Lead dedup + LeadSession custom | ❌ NON — utiliser les **goals staminads natifs** (`event: form_submission`) comme tout autre analytics |
| Ajouter PWA + push notifications dans la console | ❌ NON — archivé 2026-05-23 |
| Créer une page admin Robert globale (legacy `app/admin/page.tsx`) | ❌ NON — pas besoin d'admin global en V1 |

Ces features sont **désactivées commercialement**, pas en attente de
réactivation automatique. Toute réactivation = décision business Robert.

### Memories à charger pour comprendre la vision

- `[[project_analytics_vision_scope_final]]` — scope figé 2026-05-23 (repo
  legacy), source de la vision répercutée ici
- `[[project_session_handoff_2026-05-24]]` — état post-refonte UI native
  pure + i18n FR, tickets pending
- `[[feedback_no_local_docker_build]]` — INTERDIT de build/test/install en
  local (PC Robert 7.6Gi crashe)
- `[[feedback_subagents_opus_only]]` — `model: "opus"` obligatoire sur tout
  spawn `Agent()` de ce projet
- `[[project_analytics_engine_dev_env]]` — env DEV hot-reload bind-mount
  sur dev-pub + Tailscale serve
- `[[project_ci_architecture]]` — Husky strict + workflows turbo 5 étages +
  E2E Playwright
- `[[feedback_never_touch_other_agents]]` — worktree isolé strict

---

## Architecture two-tier (rappel)

```
veridian-bridge/  (Express + Postgres, dans CE repo)
    └─ Auth Veridian, intégration Hub, GSC, magic links, provisioning M2M,
       webhooks téléphonie (OVH puis CPaaS moderne)
    └─ HTTP → staminads engine (NestJS + ClickHouse, dans CE repo aussi)
                └─ Ingestion events + dashboards + AI assistant
```

Le bridge transforme les signaux Veridian (appel téléphone, hit GSC, hook
provisioning) en **events staminads natifs** via `POST /api/track` sur
l'engine. **Aucune page UI custom n'est ajoutée à staminads** — c'est tout
l'intérêt.

## Stack technique

- **Backend engine** : NestJS + TypeScript (`api/`)
- **Bridge Veridian** : Express + TypeScript + Postgres (`veridian-bridge/`)
- **Database analytics** : ClickHouse (sub-50ms queries, partitionnée par
  jour)
- **Frontend** : React + Vite + TanStack Router + Ant Design (`console/`)
- **SDK tracker** : staminads SDK + patches Veridian (`sdk/`, ajout
  `visitor_id` first-party)

## Hygiène code — règles dures

### ZÉRO build local

Les builds (`npm install`, `vite build`, `vitest`, `playwright install`,
`docker build`) explosent la RAM de la machine de Robert (7.6Gi). **Tout
build/test/install lourd → CI GitHub Actions ou dev-pub via SSH.**

Cf memory `feedback_no_local_docker_build` (durcie 2026-05-22). Cette règle
écrase les instructions staminads upstream qui suggèrent
`npm run build && npm run test`.

Si tu DOIS valider un truc, utilise :
- L'env hot-reload sur dev-pub (cf `VERIDIAN-README.md` §"Env DEV
  hot-reload")
- Les workflows GitHub Actions sur push staging
- `tsc --noEmit` léger en local OK ponctuellement, mais pas en boucle

### Sous-agents en Opus uniquement

Tout spawn `Agent()` dans ce projet DOIT passer `model: "opus"`. **Jamais
Sonnet.** Cf memory `feedback_subagents_opus_only`. Sonnet bâcle les
tâches sensibles (cf incident 2026-05-21 sur `veridian-hub`).

### Husky pre-push ULTRA-STRICT

JAMAIS `--no-verify`. Le pre-push lance :
1. Refus push sur `main` (photo de prod, auto-promotion uniquement)
2. Conventional Commits
3. Test-mapping (source modifié → test correspondant exigé)
4. Integration-coverage (fichiers critiques → test `*.integration.test.ts`)
5. Audit static (eval/exec/secrets/it.only)
6. ENV sync (`process.env` ↔ `.env.example`)
7. Bridge typecheck + tests unitaires (`test:ci`, exclut intégration)
8. `npm audit --omit=dev --audit-level=high` sur bridge

Si pre-push échoue : fix la cause. Pas de bypass.

### Worktree isolé strict

Ne jamais travailler dans le checkout principal partagé entre agents. Chaque
agent doit `git worktree add` un dossier dédié. Cf memory
`feedback_never_touch_other_agents` et incident 2026-05-22 où 2 agents se
sont écrasés mutuellement.

## Workflow Git — trunk-based sur `staging`

Cf doc cross-repo `~/Bureau/veridian-platform/CLAUDE.md` §"🔥 Règle d'or :
trunk-based sur `staging`".

- **`staging`** : trunk de travail. Toutes modifs vont ici directement
  (`git push origin staging`)
- **`main`** : photo de prod, reçoit via **auto-promotion** depuis staging
  (jamais via PR humaine)
- ❌ Pas de branche feature longue
- ❌ Pas de PR éternelle
- ✅ Markers de risque dans le commit subject (`[risk:low|medium|high]`)
  pour driver l'auto-promotion (cf §20 protocole Hub, à migrer ici)

Exception : pour ce ticket précis (mise à jour `CLAUDE.md` v2026-05-25),
branche dédiée + PR vers staging tolérée car c'est un changement de
**doctrine** qui mérite trace explicite.

## URLs & deploy

| Env | URL | Branche | Deploy |
|---|---|---|---|
| Dev hot-reload | `analytics-engine-dev.staging.veridian.site` (Tailnet only) | `dev` | bind-mount + watch |
| Staging | `analytics-engine.staging.veridian.site` | `staging` | GHCR + SSH dev-pub auto |
| Prod | `analytics-engine.app.veridian.site` | `main` | GHCR + Trivy + Dokploy API auto |

## Inter-services

Cet engine est consommé par **Hub** (provisioning M2M à câbler) et par
les **sites clients** (snippet SDK tracker). Le bridge expose :
- `POST /api/admin/provision` (M2M, à finaliser dans le ticket Hub à
  venir) — créé tenant + workspace + user + API key + magic link
- `POST /api/track` (public, SDK) — relai vers engine ClickHouse
- `POST /api/webhooks/telephony/<provider>` (provider → bridge) — push
  events `phone_call` vers engine

Tout changement de l'API admin doit être **coordonné avec le repo Hub**
(cf §"Règle opérationnelle : APIs pilotées par le Hub" racine
`veridian-platform/CLAUDE.md`).

## Pour aller plus loin

- Stack technique détaillée : `VERIDIAN-README.md`
- Roadmap globale Veridian : `~/Bureau/veridian-platform/TODO.md`
  (refresh via `./scripts/refresh-todo.sh`)
- Architecture CI/CD : `docs/CI-ARCHITECTURE.md` (engine) +
  `~/Bureau/veridian-platform/veridian-hub/docs/CI-ARCHITECTURE.md` §20
  (protocole promotion graduée à migrer ici)
- Vision legacy : `~/Bureau/veridian-platform/veridian-analytics/CLAUDE.md`
  §"VISION ANALYTICS — figée 2026-05-23"
- Pattern blue-green migrations : memory `project_blue_green_pattern`

## Règles absolues

- **JAMAIS** modifier la prod sans accord
- **JAMAIS** désactiver le CVE audit gate (`pnpm audit --prod
  --audit-level high`)
- **JAMAIS** push direct sur `main` (photo de prod, auto-promotion only)
- **JAMAIS** `--no-verify` sur Husky
- **JAMAIS** créer une sous-route Veridian dédiée dans la console
- **JAMAIS** introduire une page admin UI custom (provisioning = skill +
  API M2M)
- **JAMAIS** intégrer Google Ads natif dans l'app (numéros suffisent)
- **JAMAIS** ajouter un toggle EN/FR (français only)
- **TOUJOURS** snapshot avant migration DB destructive
- **TOUJOURS** réfléchir aux tenants existants avant feature DB-impacting
- **TOUJOURS** déposer un événement `phone_call` natif staminads plutôt
  que d'inventer une UI custom

---

## Annexe : doc upstream staminads

La doc technique staminads (structure API, OpenAPI, scripts SDK, versioning,
release process upstream) reste valable mais est **moins prioritaire** que
la vision Veridian ci-dessus. À consulter si tu touches à du code staminads
pur (ex : ajout d'un endpoint dans `api/src/`, modif SDK).

### Project structure

```
/api          NestJS TypeScript API (staminads upstream)
/console      React frontend (Vite + TypeScript + Ant Design + TanStack)
/sdk          JavaScript/TypeScript tracking SDK (staminads + patches Veridian)
/docs         Technical documentation and specs
/releases     Release notes per version
/veridian-bridge  Express + Postgres bridge Veridian (PATCH spécifique)
```

### OpenAPI

`@nestjs/swagger` avec CLI plugin. Générer : `npm run openapi:generate`
(à lancer en CI ou sur dev-pub, pas en local).

Conventions controllers : `@ApiTags`, `@ApiOperation`, `@ApiSecurity`,
`@Public`, `@DemoProtected`. Cf doc upstream historique pour les détails.

### Versioning

Version définie dans `api/src/version.ts` et synchronisée API + console
(via Vite `__APP_VERSION__`) + SDK (via Rollup `__SDK_VERSION__`).

- **Major (X.0.0)** : changements de schéma DB (migration requise)
- **Minor (0.X.0)** : features et fixes sans changement de schéma

### Métriques

**Ne jamais arrondir les métriques entières.** Les compteurs (`sessions`,
`goals`, `pageviews`) doivent toujours rester des entiers. Si ça arrive en
float, c'est un bug upstream dans la query / l'aggrégation — fixer la cause
racine, pas masquer avec un `Math.round`.
