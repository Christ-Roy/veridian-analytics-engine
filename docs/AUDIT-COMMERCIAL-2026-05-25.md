# Audit commercial Veridian Analytics Engine — 2026-05-25

> **Auditeur** : Claude Opus 4.7 — agent senior produit/tech Veridian
> **Branche base** : `origin/staging` @ `43aa4d4` (refonte UI native pure mergée, SECU-P0 PR #29 mergé `adbea3d` après création de ce worktree)
> **Méthode** : lecture statique du repo + `curl` sur prod `analytics-engine.app.veridian.site` (staging derrière Tailscale). **Aucun build local.**
> **Mandat** : déterminer si l'engine est commercialisable en mass-onboarding via skill `analytics-provision`.
>
> **TL;DR — Verdict** : **NON commercialisable en l'état**. Les briques sont là (visiteurs + Calls + GSC + onglets Settings + bridge HMAC), mais 5 P0 bloquent le mass-onboarding : (1) pas d'API M2M plateforme pour créer un tenant en 1 call, (2) dimension `source` absente sur `phone_call` (donc l'attribution SEO vs Ads ne marche pas), (3) headers sécu prod (CSP/x-powered-by) non corrigés malgré E2E qui les testent, (4) ~20 strings EN résiduels dans `GoalDashboardDrawer.tsx`, (5) bridge utilise un login admin password-based (super_admin JWT) pour proxier les actions plateforme — pas un vrai flow M2M robuste.

---

## 1. État API admin tenants / workspaces / users

### Endpoints engine NestJS (`api/src/`)

| Endpoint | Méthode | Auth | Source | Notes |
|---|---|---|---|---|
| `POST /api/setup.initialize` | POST | Public (gated par `isSetupComplete()`) | `api/src/setup/setup.controller.ts:54` | Crée le **premier** admin uniquement. Retourne 400 si déjà initialisé. Lock backend OK (vérifié `setup.service.ts:50`). |
| `GET  /api/setup.status` | GET | Public | `api/src/setup/setup.controller.ts:21` | Retourne `{setupCompleted: bool}`. |
| `POST /api/auth.login` | POST | Public, rate-limited | `api/src/auth/auth.controller.ts:38` | Email + password → JWT. C'est le SEUL moyen pour le bridge d'obtenir un token "admin" (cf. `veridian-bridge/src/app.ts:147` `getAdminToken`). |
| `POST /api/auth.forgotPassword` | POST | Public | `auth.controller.ts:67` | |
| `POST /api/auth.resetPassword` | POST | Public | `auth.controller.ts:90` | |
| `GET  /api/auth.me` | GET | JWT | `users.controller.ts:29` | |
| `POST /api/auth.updateProfile` | POST | JWT | `users.controller.ts:42` | |
| `POST /api/auth.changePassword` | POST | JWT | `users.controller.ts:53` | |
| `GET  /api/auth.sessions` | GET | JWT | `auth.controller.ts:106` | |
| `POST /api/auth.revokeSession` | POST | JWT | `auth.controller.ts:131` | |
| `POST /api/auth.revokeAllSessions` | POST | JWT | `auth.controller.ts:152` | |
| `GET  /api/workspaces.list` | GET | JWT (super_admin = all) | `workspaces.controller.ts:41` | |
| `GET  /api/workspaces.get` | GET | JWT/api-key (WorkspaceAuthGuard) | `workspaces.controller.ts:46` | |
| `POST /api/workspaces.create` | POST | JWT, `DemoRestricted` | `workspaces.controller.ts:57` | **Pas de check super_admin explicite** — n'importe quel user logged-in peut créer un workspace, sauf en mode démo. |
| `POST /api/workspaces.update` | POST | JWT/api-key + `workspace.settings` | `workspaces.controller.ts:62` | |
| `POST /api/workspaces.delete` | POST | JWT/api-key + `workspace.delete` | `workspaces.controller.ts:76` | |
| `POST /api/apiKeys.create` | POST | JWT/api-key + `apiKeys.manage` | `api-keys.controller.ts:40` | API key **workspace-scoped**, role admin/editor/viewer, format `stam_live_*`. |
| `GET  /api/apiKeys.list` | GET | JWT (JwtOnly) | `api-keys.controller.ts:55` | |
| `GET  /api/apiKeys.get` | GET | JWT (JwtOnly) | `api-keys.controller.ts:90` | |
| `POST /api/apiKeys.revoke` | POST | JWT (JwtOnly) | `api-keys.controller.ts:103` | |
| `GET  /api/members.list` | GET | JWT/api-key (WorkspaceAuthGuard) | `members.controller.ts:38` | |
| `POST /api/members.updateRole` | POST | JWT/api-key + `members.manage` | `members.controller.ts:120` | |
| `POST /api/members.remove` | POST | JWT/api-key + `members.remove` | `members.controller.ts:157` | |
| `POST /api/members.leave` | POST | JWT (JwtOnly) | `members.controller.ts:179` | |
| `POST /api/members.transferOwnership` | POST | JWT (JwtOnly) | `members.controller.ts:209` | |
| `GET  /api/invitations.list` | GET | JWT/api-key | `invitations.controller.ts:38` | |
| `POST /api/invitations.create` | POST | JWT/api-key + `members.invite` | `invitations.controller.ts:51` | Envoie un email avec lien magique. |
| `POST /api/invitations.resend` | POST | JWT | `invitations.controller.ts:65` | |
| `POST /api/invitations.revoke` | POST | JWT | `invitations.controller.ts:79` | |
| `GET  /api/invitations.get` | GET | Public (token-based) | `invitations.controller.ts:96` | |
| `POST /api/invitations.accept` | POST | Public (token-based, crée user si besoin) | `invitations.controller.ts:108` | **C'est le SEUL chemin de création de user en dehors de `/setup.initialize`.** |

### Endpoints bridge Express (`veridian-bridge/src/`)

| Endpoint | Auth | Source | Notes |
|---|---|---|---|
| `POST /api/tenants/provision` | HMAC Hub (`HUB_HMAC_SECRET`) | `veridian-bridge/src/hub/provision.ts:54` | Endpoint contrat Hub — crée un workspace staminads + apiKey en 1 call. **C'est l'équivalent fonctionnel attendu par le skill `analytics-provision`, mais signature HMAC, pas Bearer.** |
| `POST /api/admin/provision-tenant` | Bearer `VERIDIAN_ADMIN_API_KEY` | `veridian-bridge/src/app.ts:219` | Variante onboarding manuelle (admin). Crée workspace + apiKey. |
| `POST /api/admin/provision-existing-tenant` | Bearer `VERIDIAN_ADMIN_API_KEY` | `veridian-bridge/src/admin/provision-existing-tenant.ts` | Migration D2 — adopte un siteKey legacy. |
| `POST /api/admin/track-test` | Bearer admin | `app.ts:300` | |
| `GET  /api/admin/tenant/:wsId/score` | Bearer admin | `app.ts:394` | Score Veridian (feature débranchée scope mais endpoint live). |
| `GET  /api/admin/tenant/:wsId/status` | Bearer admin | `app.ts:518` | |
| `GET  /api/admin/tenant/:wsId/check-tracker` | Bearer admin | `app.ts:568` | Wizard onboarding U4. |
| `GET  /api/admin/tenant/:wsId/settings` | Bearer admin | `veridian-bridge/src/settings/routes.ts:108` | Lit settings tenant + creds masqués. |
| `PUT  /api/admin/tenant/:wsId/settings` | Bearer admin | `settings/routes.ts:140+` | |
| `GET  /api/admin/tenant/:wsId/credentials` | Bearer admin | `settings/routes.ts` | Liste creds (masqués). |
| `POST /api/admin/tenant/:wsId/credentials` | Bearer admin | `settings/routes.ts` | Enregistre cred chiffré AES-256-GCM. |
| `POST /api/admin/tenant/:wsId/credentials/:kind/test` | Bearer admin | `settings/routes.ts` | Test API key live. |
| `DELETE /api/admin/tenant/:wsId/credentials/:kind` | Bearer admin | `settings/routes.ts` | |
| `POST /api/admin/gsc/oauth-begin?tenantId=` | Bearer admin | `veridian-bridge/src/gsc/routes.ts:40` | Génère URL OAuth Google. |
| `GET  /api/admin/gsc/oauth-callback` | Public (gardé par `state`) | `gsc/routes.ts:74` | Réception du code OAuth. |
| `POST /api/admin/gsc/sync` | Bearer admin | `gsc/routes.ts` | Sync manuel d'une property GSC. |
| `POST /api/admin/gsc/sync-all` | Bearer admin OR IP allowlist (cron) | `gsc/routes.ts` | |
| `GET  /api/admin/tenant/:wsId/gsc?days=N` | Bearer admin | `gsc/routes.ts` | Dashboard GSC. |

### Ce qui manque pour le skill `analytics-provision`

Le skill cible doit faire en **1 call** : tenant + workspace + user + API key + invite email. Voilà l'état :

| Besoin skill | État engine | Verdict |
|---|---|---|
| 1 call M2M "createTenant({email, siteUrl, name})" | ❌ Aucun endpoint M2M unifié sur **l'engine**. Le bridge a `POST /api/admin/provision-tenant` (Bearer `VERIDIAN_ADMIN_API_KEY`) mais il **ne crée PAS de user**, juste workspace + apiKey staminads. | **P0 BLOQUANT** : le skill doit chaîner `bridge.provision-tenant` (workspace + apikey) puis appeler engine `invitations.create` via JWT super_admin pour envoyer l'invite email. Pas atomique. |
| 1 endpoint M2M pour récupérer le snippet tracker | ⚠️ Le snippet est construit dans `provision-existing-tenant.ts:buildTrackerSnippet()` mais **pas exposé** comme endpoint dédié (uniquement renvoyé dans la réponse `provision-existing`). | **P1** : ajouter `GET /api/admin/tenant/:wsId/snippet` qui retourne `<script>` prêt à coller. |
| 1 endpoint M2M pour attacher GSC / OVH | ⚠️ Existe (`POST /api/admin/tenant/:wsId/credentials`) mais demande au client de coller ses creds manuellement. Pour GSC c'est OAuth user-driven → pas automatisable côté skill. Pour OVH c'est OK si Robert connaît les creds client. | **OK pour OVH**, **manuel pour GSC** (le client doit OAuth lui-même via UI). |
| API key admin plateforme (M2M, pas workspace-scoped) | ❌ **Pas de concept** d'api key plateforme. Le bridge se logue avec un super_admin password (`STAMINADS_ADMIN_EMAIL` + `STAMINADS_ADMIN_PASSWORD`) et cache un JWT 6 jours. Voir `veridian-bridge/src/app.ts:147-194`. **C'est un anti-pattern sécu** (password long-lived, rotate impossible sans redéploiement bridge, JWT cache en mémoire perdu au restart). | **P0 BLOQUANT** : il FAUT un vrai API key plateforme (header `Authorization: Bearer <ADMIN_API_KEY>`) qui bypasse `WorkspaceAuthGuard` et permet la création de workspace/user en M2M. Sinon le bridge reste un proxy fragile. |

### Recommandation §1

Créer un nouveau module engine `api/src/admin/` avec :
- Stratégie `PlatformAdminApiKeyStrategy` (Bearer `PLATFORM_ADMIN_API_KEY` env, hash en DB).
- `POST /api/admin/platform/tenants.provision` qui en 1 call crée : workspace + super-owner user + workspace api key + envoi email invitation.
- `GET /api/admin/platform/tenants.snippet?workspaceId=...` qui retourne le snippet HTML.

Ça remplace le hack `STAMINADS_ADMIN_PASSWORD` bridge → vraie isolation M2M.

---

## 2. État Calls / VoIP / OVH

### Ce qui est livré (branche `feat/B-VOIP-call-logs` mergée dans staging)

- **Bridge ingestion** : `veridian-bridge/src/voip/` (sync.ts, providers/ovh.ts, providers/telnyx.ts, credentials.ts, match.ts, types.ts).
  - Pull des CDR OVH/Telnyx avec fenêtre 30j configurable.
  - Idempotence via `@@unique(provider, externalId)` sur `SipCall`.
  - Match `visitorId` (clic `tel:` tracké → appel reçu) via `match.ts:resolveVisitorIds`.
  - **Push event `goal` name=`phone_call` vers `staminads/api/track`** (`veridian-bridge/src/voip/sync.ts:184-217`).
- **Bridge routes** : `veridian-bridge/src/voip/routes.ts` expose admin endpoints pour pull manuel + status.
- **Console** : onglet **Settings → VoIP** (`console/src/veridian/settings-panels/voip-panel.tsx`, 622 lignes).
  - 2 providers (OVH / Telnyx) avec formulaires creds chiffrés AES-256-GCM.
  - Liste creds enregistrés (masqués), test live, suppression.
  - Mini-récap appels syncés sur 30j + lien "Voir les appels dans Live".
- **Console route** : intégration dans `settings.tsx:733` via `<VoIPSettingsPanel workspaceId={workspaceId} />`. Section `voip` dans le `z.enum`.
- **Test bridge** : `veridian-bridge/tests/voip/sync.push.test.ts` couvre le push event.

### Ce qui manque

| Gap | Sévérité | Fichier impacté |
|---|---|---|
| **Dimension `source` (seo/ads/direct) sur event `phone_call`** | 🔴 P0 | `veridian-bridge/src/voip/sync.ts:184-217` — le payload `properties` n'a pas de champ `source`. Robert (2026-05-25) : "1 numéro par source. Quand un appel arrive, le bridge tag l'event `phone_call` avec une dimension `source`". |
| Mapping numéro → source | 🔴 P0 | Aucune table de mapping `phone_number → source` n'existe en DB bridge. Le `toNumber` du CDR doit être lookup dans une table `TenantPhoneNumbers(tenantId, number, source)` pour résoudre la source. |
| Settings UI pour déclarer les numéros et leur source | 🔴 P0 | Pas de section dans `voip-panel.tsx` pour mapper "+33177xxxx → seo", "+33178xxxx → ads". |
| Validation OVH live | 🟡 P1 | Le `testCredential` existe mais la doc/runbook OVH credentials (app key, secret, consumer key + validation API CSE) n'est pas dans le repo. Risque que le client se trompe à la saisie. |
| CPaaS futur (Twilio, Aircall, etc.) | 🟢 P2 | Architecture providers est extensible (`voip/providers/*.ts`). À ajouter quand besoin client réel. |

### Recommandation §2

1. Ajouter `TenantPhoneNumber` table Prisma `(id, tenantId, e164, source ENUM[seo,ads,direct,other])` + CRUD dans settings bridge.
2. Étendre `voip-panel.tsx` : sous-section "Numéros trackés" avec mapping → source.
3. Patcher `voip/sync.ts:184-217` pour lookup le `toNumber` et injecter `properties.source` dans le payload `/api/track`.
4. Faire apparaître `source` comme dimension custom staminads (via `custom_dimensions` workspace settings) → ça remonte automatiquement dans Live/Explore/Goals.

---

## 3. État GSC (Search Console)

### Ce qui est livré

- **OAuth Google** : `veridian-bridge/src/gsc/oauth.ts` — flow standard avec scope `webmasters.readonly`. Tokens chiffrés AES-256-GCM (clé `TOKEN_ENCRYPTION_KEY` 32 bytes).
- **Refresh handling** : géré dans `oauth.ts` (refresh_token persisté, `expires_at` recalculé à chaque pull).
- **Sync** : `gsc/sync.ts` pull les queries + pages + clicks/impressions/CTR/position. `gsc/query.ts` agrège pour dashboard.
- **Console** : onglet **Settings → Search Console** (`console/src/veridian/settings-panels/search-console-panel.tsx`, 612 lignes).
  - Status connexion + bouton "Connecter Search Console" (OAuth).
  - KPIs (clics, impressions, CTR, position) sur fenêtre paramétrable.
  - TimeSeriesChart multi-courbes.
  - Tables Mots-clés / Pages triables.

### Ce qui manque

| Gap | Sévérité | Source |
|---|---|---|
| **Endpoint `disconnect` côté bridge** | 🟡 P1 | Cf ticket legacy `2026-05-24-gsc-disconnect-endpoints-bridge.md` — pas de DELETE pour révoquer la connexion GSC. Implique reset manuel via DB ou re-OAuth. |
| Indexation / sitemap status | 🟢 P2 | Cf ticket legacy `2026-05-23-gsc-indexation-bonus.md` — l'API GSC permet de récupérer indexation status mais pas implémenté. Pas bloquant V1. |
| Multi-property GSC par workspace | 🟢 P2 | Aujourd'hui 1 GSC → 1 workspace. Si client a plusieurs sub-domains, manque. Pas urgent. |

**État global GSC : LIVRABLE V1 sans plus.** Le panel Settings est dense et fonctionnel.

---

## 4. État FR (i18n)

### Périmètre du merge `feat/french-i18n` (commit `7ca46cc`)

- Sidebar nav (annotations, dimensions, etc.) → ✅ FR
- Settings layout : tous les libellés menu (`Espace de travail`, `Équipe`, `Intégrations`, `Email (SMTP)`, etc.) → ✅ FR (`settings.tsx:76-84`)
- `goals.tsx` route → ✅ FR ("Objectifs", "Aucun objectif suivi")
- Account, password change, workspace create → ✅ FR
- AntDesign locale `frFR` + Day.js `fr` configurés (`main.tsx`, cf `docs/I18N.md`)
- HTML `lang="fr"` (`index.html`)

### Trous EN résiduels — audit ciblé

**`console/src/components/goals/GoalDashboardDrawer.tsx`** (drawer ouvert quand on clique sur un goal) :

| Ligne | String EN | Remplacement FR proposé |
|---|---|---|
| 28 | `label: 'Count'` | `'Nombre'` |
| 35 | `label: 'Count'` | `'Nombre'` |
| 36 | `label: 'Value'` | `'Valeur'` |
| 41 | `label: 'Goals'` | `'Objectifs'` |
| 191 | `label: 'Referrers', dimensionLabel: 'Referrer'` | `'Référents'`, `'Référent'` |
| 191 | `label: 'Channels', dimensionLabel: 'Channel'` | `'Canaux'`, `'Canal'` |
| 192 | `label: 'Channel Groups', dimensionLabel: 'Group'` | `'Groupes de canaux'`, `'Groupe'` |
| 197 | `label: 'Campaigns', dimensionLabel: 'Campaign'` | `'Campagnes'`, `'Campagne'` |
| 198 | `label: 'Sources', dimensionLabel: 'Source'` | `'Sources'`, `'Source'` (déjà OK) |
| 199 | `label: 'Mediums', dimensionLabel: 'Medium'` | `'Supports'`, `'Support'` |
| 203 | `label: 'Map', dimensionLabel: 'Country'` | `'Carte'`, `'Pays'` |
| 204 | `label: 'List', dimensionLabel: 'Country'` | `'Liste'`, `'Pays'` |
| 208 | `label: 'Devices', dimensionLabel: 'Device'` | `'Appareils'`, `'Appareil'` |
| 209 | `label: 'Browsers', dimensionLabel: 'Browser'` | `'Navigateurs'`, `'Navigateur'` |
| 210 | `label: 'OS', dimensionLabel: 'OS'` | OK (acronyme) |
| 233 | `<span>Goal Dashboard</span>` | `'Tableau de bord d\'objectif'` |

**`console/src/components/explore/BreakdownTable.tsx:51`** : `title: 'Sessions'` → utiliser `'Sessions'` (acronyme OK, ou `'Visites'`).

**`console/src/components/explore/ExploreTable.tsx:312`** : idem.

**`console/src/routes/_authenticated/workspaces/$workspaceId/settings.tsx:530`** : `placeholder="Enter dimension label (leave empty to clear)"` → `"Saisir le libellé de dimension (vide pour effacer)"`.

**`console/src/routes/_authenticated/workspaces/$workspaceId.tsx`** lignes 224 + 476 : `label: 'Annotations'` → OK (mot identique FR/EN, mais à valider).

### Sidebar, breadcrumbs, modals — verdict

Sidebar layout principal : ✅ 100% FR. Breadcrumbs : ✅. Modals AntD : ✅ FR via `frFR` locale (boutons OK/Cancel, DatePicker, etc.).

### Recommandation §4

Ajouter une passe ciblée sur `GoalDashboardDrawer.tsx` (1 fichier, ~16 strings) — c'est le seul trou visible en usage normal. Le reste passe inaperçu (BreakdownTable header n'est pas visible à l'œil nu si la métrique est nommée "Sessions" en FR aussi).

**Sévérité globale : 🟡 P1** — pas bloquant pour vendre mais visible à un prospect qui ouvre un goal.

---

## 5. État sécu engine — reprise des 23 bugs `bugs-2026-05-23`

| Ticket | Sévérité legacy | État engine 2026-05-25 | Notes |
|---|---|---|---|
| **BUG-01** /setup admin form publiquement exposé | 🔴 P0 | ✅ **FIXÉ** (PR #29 mergé `adbea3d` 2026-05-25 00:58) | Fix client-side `setup-guard.ts` fail-CLOSED + backend lock unit tests. **MAIS : pas encore déployé en prod** — `curl prod /setup` retourne toujours 200 (HTML SPA shell). Backend lock OK (`/api/setup.initialize` retourne 400). Risque résiduel : phishing visuel jusqu'au prochain deploy. |
| **BUG-02** Onglet Veridian = 404 | 🔴 P0 | ✅ **FIXÉ** (PR #2 + PR #4 mergées). L'onglet `veridian` est gated `IS_DEMO` correctement. |
| **BUG-03** /goals page blanche | 🔴 P0 | ✅ **FIXÉ** (commit `cb02c61` + `c54cd94` — coerce métriques ClickHouse). |
| **BUG-04** /filters page blanche | 🔴 P0 | ✅ **FIXÉ** (PR #4 ui-polish-core). |
| **BUG-05** /settings page blanche | 🔴 P0 | ✅ **FIXÉ** (PR #4 ui-polish-core). |
| **BUG-06** Live counter garbage number | 🔴 P0 | ✅ **FIXÉ** (commit `9e0d123` branding cleanup). |
| **BUG-07** /install-sdk 404 | 🔴 P0 | ✅ **FIXÉ** (route ajoutée `install-sdk.tsx` listée dans le routes tree). |
| **BUG-08** `<title>Staminads</title>` hardcoded | 🔴 P0 | ✅ **FIXÉ** (`<title>Veridian Analytics</title>` confirmé en prod). |
| **BUG-09** Logo `alt="Staminads"` | 🔴 P0 | ✅ **FIXÉ** (`alt="Veridian Analytics"`). |
| **BUG-10** Liens docs.staminads.com | 🔴 P0 | ✅ **FIXÉ** (commit `9e0d123`). |
| **BUG-11** robots.txt incorrect engine prod | 🔴 P0 | ✅ **FIXÉ** (commit `c7870d6`). |
| **BUG-12** /account exposée + bilingue | 🟡 P1 | ✅ **FIXÉ** (PR #2 fix/demo-veridian-bugs). |
| **BUG-13** Version `v6.1.0` exposée | 🟢 P2 | ❌ **PAS FIXÉ** — `curl prod /api/health` retourne `"version":"6.1.0"`. Le `api/src/version.ts` n'a pas été renommé à `veridian-analytics-engine` versioning. **Source : `api/src/version.ts`** |
| **BUG-14** Apple logo loaded from apple.com | 🟡 P1 | ⏳ À vérifier — pas trouvé de fix explicite dans le git log. |
| **BUG-15** Timezone america/new_york sur demo FR | 🟡 P1 | ⏳ À vérifier sur démo prod. |
| **BUG-16** Boutons sans accessible label | 🟡 P1 | ⏳ Pas de PR ciblée a11y. Statut inconnu. |
| **BUG-17** Pas de CSP header | 🟡 P1 | ❌ **PAS FIXÉ** — `curl -I prod /` ne retourne **pas** de `content-security-policy`. Pas de `helmet` configuré dans `api/src/main.ts`. **Source : `api/src/main.ts:1-60` (pas d'import helmet)** |
| **BUG-18** `x-powered-by: Express` exposé | 🟢 P2 | ❌ **PAS FIXÉ** — `curl -I prod /` retourne `x-powered-by: Express`. Aucun `app.disable('x-powered-by')` dans le code. **Source : `api/src/main.ts`** |
| **BUG-19** /annotations page minimale | 🟡 P1 | ⏳ À vérifier — route existe (`annotations.tsx`) mais contenu pas audité. |
| **BUG-20** Cold load FOUC | 🟡 P1 | ✅ **FIXÉ** (splash branded inline dans `index.html` confirmé en prod). |
| **BUG-21** Logout button shown on demo | 🟡 P1 | ✅ **FIXÉ** (PR #2). |
| **BUG-22** `/api/tools.favicon` public sans rate-limit | 🟡 P1 | ❌ **PAS FIXÉ** — `tools.controller.ts:43` décoré `@Public()`. Pas de `@Throttle()` ni d'allowlist domaine. Risque SSRF + abus pour fetch arbitraire. **Source : `api/src/tools/tools.controller.ts:43`** |
| **BUG-23** Contact email perso démo | 🟢 P2 | ⏳ `public-config` prod retourne `"contact_email":"robert.brunon@veridian.site"` — OK (email pro). Démo à re-vérifier. |

### Synthèse sécu

| État | Count | Tickets |
|---|---|---|
| ✅ Fixé | 14 | BUG-01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 20, 21 |
| ❌ Pas fixé | 4 | BUG-13, 17, 18, 22 |
| ⏳ À vérifier | 5 | BUG-14, 15, 16, 19, 23 |

**Sécu engine = livrable client ? OUI mais avec dette technique acceptable :**

- 🟢 **OK pour vendre** : auth flow propre (JWT + bcrypt + sessions révocables), creds tiers chiffrés AES-256-GCM, headers fondamentaux présents (HSTS/X-Frame/Referrer), CORS contrôlable.
- 🟡 **Dette à corriger semaine 1** : ajouter `helmet` dans `main.ts` (couvre BUG-17 CSP + BUG-18 x-powered-by en 5 minutes), throttle + allowlist sur `/api/tools.*` (BUG-22).
- 🟢 **Cosmétique** : BUG-13 version `6.1.0` → bump à `0.1.0` engine-spécifique quand renommage propre.

---

## 6. Branches feature pendantes

### Audit `git log origin/staging..origin/feat/X`

**Toutes les branches feat/fix listées sont à 0 commits ahead de `origin/staging`.** Aucune branche feature ne contient du contenu non mergé.

| Branche | Commits ahead | Statut |
|---|---|---|
| `origin/feat/B-VOIP-call-logs` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/D2-migration-scripts` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/U4-onboarding-wizard` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/U7-deploy-demo` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/U8-settings-credentials` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/U9-calls-auth` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/e2e-battery` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/e2e-promise-flows` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/french-i18n` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/ui-native-integration` | 0 | ✅ Mergée — à supprimer |
| `origin/feat/ui-welcome-native` | 0 | ✅ Mergée — à supprimer |
| `origin/fix/SECU-P0-setup-bootstrap` | 0 | ✅ Mergée — à supprimer |
| `origin/fix/blank-workspace-pages-bug03` | 0 | ✅ Mergée — à supprimer |
| `origin/fix/compose-env-audit` | 0 | ✅ Mergée — à supprimer |
| `origin/fix/prod-compose` | 0 | ✅ Mergée — à supprimer |

### Recommandation §6

Cleanup des 15 branches mergées : `git push origin --delete <branch>` pour réduire le bruit (et éviter qu'un agent reparte d'une branche stale). Aucune valeur retenue ailleurs.

---

## 7. Verdict commercialisable

### Bloquants P0 (avant mass-onboarding via skill)

1. **API M2M plateforme manquante** (§1) — pas d'endpoint engine pour "créer tenant+user+apikey+invite" en 1 call. Le bridge se loggue en super_admin password pour proxier, c'est un anti-pattern.
   - **Effort** : 2-3j (nouveau module `api/src/admin/`, stratégie passport, controller, tests E2E).
   - **Sans ça** : le skill doit chaîner 3-4 appels HTTP (provision bridge + login engine super_admin + invitations.create + apiKeys.create) avec gestion d'erreur fragile.

2. **Dimension `source` (seo/ads/direct) absente sur event `phone_call`** (§2) — Robert l'a explicitement demandé le 2026-05-25. Sans ça, l'attribution des calls par canal ne marche pas, et c'est la valeur principale du tracking téléphonie multi-numéros.
   - **Effort** : 1j (table `TenantPhoneNumber`, UI mapping dans `voip-panel.tsx`, patch `voip/sync.ts`).

3. **Headers sécu prod cassés** : `x-powered-by: Express` + pas de CSP (§5) — les E2E `tests/e2e/16-security/headers-security.spec.ts` testent l'absence d'`x-powered-by: Express`, donc la CI doit déjà casser. Soit le test ne tourne pas en CI, soit il est tolérant (`if (xpb)` → skip). À vérifier urgent.
   - **Effort** : 30 min (ajouter `helmet` dans `main.ts` + `app.disable('x-powered-by')`).

### Gênants P1 (à fixer avant les 10 premiers clients)

4. **Strings EN dans GoalDashboardDrawer** (§4) — visible sur le drawer le plus utilisé après les KPI. 1 fichier, ~16 strings.
   - **Effort** : 30 min.

5. **`tools.favicon` public sans rate-limit ni allowlist** (BUG-22) — SSRF possible, abus pour fetch arbitraire.
   - **Effort** : 1h (ajouter `@Throttle()` + check domaine vs `workspace.website`).

6. **GSC : pas d'endpoint disconnect bridge** (§3) — client ne peut pas révoquer la connexion proprement depuis l'UI Settings.
   - **Effort** : 2h.

7. **Endpoint snippet tracker non exposé** (§1) — le skill doit pouvoir récupérer le snippet HTML prêt à coller. Aujourd'hui c'est planqué dans la réponse de `provision-existing-tenant`.
   - **Effort** : 1h.

### Nice to have P2

- BUG-13 version string `6.1.0` (rename clean engine).
- Cleanup 15 branches mergées (§6).
- Indexation GSC bonus.
- BUG-14/15/19 (a11y, timezone démo, annotations page) — audit visuel à refaire sur prod après que les fixes P0 soient déployés.

### Workflow cible skill `analytics-provision` (rappel pour validation)

```
1. POST /api/admin/platform/tenants.provision  ← N'EXISTE PAS (P0 #1)
   Body: { email, siteUrl, name, phoneNumbers: [{e164, source}, ...] }
   Auth: Bearer PLATFORM_ADMIN_API_KEY (header)
   Effet:
     a. Crée workspace staminads (id slugifié)
     b. Crée user owner (avec password aléatoire + flag must_reset)
     c. Crée workspace api key role=admin (`stam_live_...`)
     d. Pour chaque phoneNumber → insert TenantPhoneNumber (P0 #2)
     e. Envoie email invitation magic-link (réutilise `invitations.create`)
   Réponse: { workspace_id, owner_user_id, api_key, snippet_html, dashboard_url }
```

Tant que cet endpoint n'existe pas, le skill doit faire le ballet via le bridge + super_admin login, ce qui est fragile et viole le principe M2M propre.

---

## Annexe — récap fichiers cités

- **API admin engine** : `api/src/setup/setup.controller.ts`, `api/src/auth/auth.controller.ts`, `api/src/users/users.controller.ts`, `api/src/workspaces/workspaces.controller.ts`, `api/src/api-keys/api-keys.controller.ts`, `api/src/members/members.controller.ts`, `api/src/invitations/invitations.controller.ts`
- **API admin bridge** : `veridian-bridge/src/app.ts:219` (provision-tenant), `veridian-bridge/src/hub/provision.ts:54` (tenants/provision HMAC), `veridian-bridge/src/admin/provision-existing-tenant.ts`, `veridian-bridge/src/settings/routes.ts`, `veridian-bridge/src/gsc/routes.ts`, `veridian-bridge/src/voip/routes.ts`
- **VoIP push** : `veridian-bridge/src/voip/sync.ts:184-217` (manque `source` dimension)
- **GSC** : `veridian-bridge/src/gsc/oauth.ts`, `console/src/veridian/settings-panels/search-console-panel.tsx`
- **Console Settings** : `console/src/routes/_authenticated/workspaces/$workspaceId/settings.tsx:733-737` (rendu VoIP + GSC), `console/src/veridian/settings-panels/voip-panel.tsx`, `console/src/veridian/settings-panels/search-console-panel.tsx`
- **i18n trous** : `console/src/components/goals/GoalDashboardDrawer.tsx:28,35,36,41,191-210,233`
- **Sécu manquante** : `api/src/main.ts` (pas de helmet), `api/src/tools/tools.controller.ts:43` (favicon public)
- **Bridge auth fragile** : `veridian-bridge/src/app.ts:147-194` (`getAdminToken` via super_admin password)
- **Bugs legacy** : `/home/brunon5/Bureau/veridian-platform/archive/legacy/veridian-analytics/todo/bugs-2026-05-23/`
