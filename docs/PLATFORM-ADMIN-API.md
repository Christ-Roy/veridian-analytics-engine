# Platform Admin API (M2M)

> **Owner** : agent veridian-analytics-engine
> **Audience** : Veridian Hub + provisioning skill `analytics-provision`
> **Created** : 2026-05-25
> **Status** : `[risk:high]` — nouvelle surface auth plateforme

## Pourquoi cette API

Le bridge `veridian-bridge` était jusqu'ici obligé de se logger avec un
super_admin email/password pour proxifier les actions de provisioning
(`getAdminToken` dans `src/app.ts:147-194`). Anti-pattern fragile :

- credentials de service stockés en clair dans Dokploy
- la rotation du password casse le bridge en silence
- pas d'audit clair "qui a provisionné ce tenant ?"

La nouvelle famille de routes `/api/admin/platform/*` remplace ce hack
par une **clé API plateforme M2M** : un seul secret partagé Hub ↔ Engine,
gated par `PlatformAdminGuard` (timing-safe Bearer check).

## Routes

### `POST /api/admin/platform/tenants.provision`

Provisionne un tenant complet en un seul call.

**Auth** : `Authorization: Bearer <PLATFORM_ADMIN_API_KEY>`

**Body** :

```json
{
  "email": "owner@boulangerie-dupont.fr",
  "siteUrl": "https://boulangerie-dupont.fr",
  "name": "Boulangerie Dupont",
  "timezone": "Europe/Paris",      // optional, default Europe/Paris
  "currency": "EUR",               // optional, default EUR
  "phoneNumbers": [                // optional
    { "e164": "+33123456789", "source": "seo" },
    { "e164": "+33987654321", "source": "ads" }
  ]
}
```

**Effets** :

1. **Pre-check email** : si `users.email` existe déjà → **409**
   (`{ error: "email_already_exists" }`). V1 ne supporte pas le pattern
   "réutiliser un user existant pour un nouveau workspace". À ajouter
   dans un sprint ultérieur si Robert valide le flow.
2. **Slugify** `name` → `workspace_id` matchant `^[a-z][a-z0-9_]*$`
   (regex DTO `CreateWorkspaceDto`). Collision : suffixe `_2`, `_3`, …
   jusqu'à 50 tentatives, puis 500.
3. **Crée le user owner** avec un password aléatoire 32 bytes base64url
   (jamais transmis : l'utilisateur reset via magic link).
4. **Crée le workspace** via `WorkspacesService.create` (status
   `initializing`, owner = user créé, super_admin synthétique).
5. **Crée l'API key** workspace-scoped `role=admin` → token format
   `stam_live_<64 hex>`.
6. **Forward phoneNumbers** au bridge si `BRIDGE_URL` +
   `BRIDGE_ADMIN_API_KEY` configurés. Sinon : status `skipped_no_bridge`
   et la réponse contient les tentatives à retry côté Hub.
7. **Envoie l'email magic-link** (password reset 24h). Échec SMTP ≠
   échec provisioning : la réponse contient toujours le `password_reset_url`.

**Compensation** : si étape 4 ou 5 échoue, le user créé à l'étape 3 est
soft-deleted pour libérer l'email. ClickHouse n'a pas de transactions —
on assume la compensation manuelle.

**Réponse 201** :

```json
{
  "workspace_id": "boulangerie_dupont",
  "owner_user_id": "9b7c6d5e-4f3a-2b1c-8d9e-0f1a2b3c4d5e",
  "api_key": "stam_live_<64 hex>",
  "snippet_html": "<script async src=\"https://analytics-engine.app.veridian.site/tracker.js\" data-workspace-id=\"boulangerie_dupont\"></script>",
  "dashboard_url": "https://analytics-engine.app.veridian.site/workspaces/boulangerie_dupont",
  "password_reset_url": "https://analytics-engine.app.veridian.site/reset-password/<token>",
  "phone_numbers": [
    { "e164": "+33123456789", "source": "seo", "status": "attached" }
  ],
  "user_created": true
}
```

**Erreurs** :

| Code | Cause |
|---|---|
| 400 | Body invalide (email manquant, siteUrl pas HTTPS, source phone hors enum, …) |
| 401 | Bearer absent / mauvais / `PLATFORM_ADMIN_API_KEY` non configuré (fail-closed) |
| 409 | `email_already_exists` (V1) |
| 500 | `provisioning_failed` (workspace/api_key insertion) — user compensé |

### `POST /api/admin/platform/workspaces.provisionApiKey`

(Ré)génère une API key workspace-scoped pour un workspace EXISTANT géré par
la plateforme (sans membre). Utilisé par le bridge pour le **cas B** du flow
HMAC Hub (ré-attach d'un tenant existant → refresh de la clé) sans recréer ni
user ni workspace (ce qui renverrait 409).

**Auth** : `Authorization: Bearer <PLATFORM_ADMIN_API_KEY>`

**Body** : `{ "workspace_id": "boulangerie_dupont", "name": "veridian-hub-...", "role": "admin" }`

**Réponse 201** : `{ "workspace_id", "api_key", "key_prefix" }`

### `POST /api/admin/platform/analytics.query`

Lance une query analytics pour N'IMPORTE QUEL workspace, en M2M. Même contrat
que `POST /api/analytics.query` (DTO natif `AnalyticsQueryDto` : `dateRange.preset`,
métriques scopées à UNE table) mais gardé par `PlatformAdminGuard` au lieu de
`WorkspaceAuthGuard`. Délègue à `AnalyticsService.query()`.

**Pourquoi** : le bridge lit le score / status / check-tracker des tenants. Il
n'a ni JWT user ni clé workspace — avant la migration M2M (2026-06-16) il se
loguait en super_admin (`getAdminToken`). Désormais il tape cet endpoint M2M.

**Auth** : `Authorization: Bearer <PLATFORM_ADMIN_API_KEY>`

**Body** (contrat natif, PAS le legacy `{type}`/`{rows}`) :

```json
{
  "workspace_id": "boulangerie_dupont",
  "metrics": ["page_count"],
  "dimensions": [],
  "dateRange": { "preset": "previous_30_days" },
  "table": "pages"
}
```

⚠️ **Une query = UNE table.** Tables analytiques : `sessions`, `pages`, `goals`.
Pour compter les **pageviews**, utiliser la métrique **`page_count`** sur la
table **`pages`** (1 ligne = 1 pageview). ⚠️ NE PAS utiliser la métrique
`pageviews` : son SQL `countIf(name='screen_view')` référence une colonne
`name` qui n'existe dans AUCUNE table analytique (elle est dans `events`, non
requêtable) → ClickHouse renvoie `Unknown identifier 'name'`. `goals` se compte
via la métrique `goals` (table `goals`). Pour pageviews + goals, deux queries
(cf. le score côté bridge).

**Réponse 200** : `{ "data": [...], "meta": {...}, "query": {...} }`

### Provisioning avec `workspace_id` explicite (migration D2)

`tenants.provision` accepte un champ optionnel `workspace_id`. Quand fourni, il
est utilisé verbatim (au lieu de slugifier `name`) — utilisé par la migration
D2 des clients legacy qui doivent garder leur id de workspace historique. Doit
matcher `^[a-z][a-z0-9_]*$` (2..50) ; si un workspace existe déjà avec cet id →
409. Omis → slug auto depuis `name` (flux par défaut).

## Variables d'env requises

| Var | Where | Required |
|---|---|---|
| `PLATFORM_ADMIN_API_KEY` | Engine API ENV (Dokploy) | **OUI** — sinon 401 universel |
| `BRIDGE_URL` | Engine API ENV (Dokploy) | Non — phoneNumbers skipped si absent |
| `BRIDGE_ADMIN_API_KEY` | Engine API ENV (Dokploy) | Non — idem |
| `TRACKER_PUBLIC_ORIGIN` | Engine API ENV (Dokploy) | Non — default `https://analytics-engine.app.veridian.site` |
| `APP_URL` | Engine API ENV (déjà présent) | Oui — pour reset URL + dashboard URL |

**Génération** :

```bash
openssl rand -base64 48
```

Puis injecter via Dokploy API :

```bash
curl -X POST "https://dokploy.veridian.site/api/compose.update" \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "composeId": "...", "env": "PLATFORM_ADMIN_API_KEY=<value>\n..." }'
curl -X POST "https://dokploy.veridian.site/api/compose.deploy" \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -d '{ "composeId": "..." }'
```

**Rotation** : poser la nouvelle valeur côté Hub + Engine simultanément
(Dokploy compose-update sur les deux), puis redeploy. Pas de fenêtre de
dual-key support en V1 (à câbler si rotation fréquente devient
nécessaire).

## Exemple curl complet

```bash
PLATFORM_KEY="$(openssl rand -base64 48)"
# (Inject into Dokploy first, then…)

curl -X POST "https://analytics-engine.app.veridian.site/api/admin/platform/tenants.provision" \
  -H "Authorization: Bearer $PLATFORM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.fr",
    "siteUrl": "https://example.fr",
    "name": "Exemple Pro",
    "phoneNumbers": [{ "e164": "+33123456789", "source": "seo" }]
  }'
```

## Workflow d'usage côté skill `analytics-provision`

Avant cette PR, le skill devait :

1. `POST /api/auth/login` avec super_admin email/password → JWT
2. `POST /api/workspaces.create` avec JWT → workspace
3. `POST /api/apiKeys.create` avec JWT → api key
4. `POST /api/invitations.create` → magic link

Après cette PR, le skill fait :

1. **Un seul** `POST /api/admin/platform/tenants.provision` avec Bearer
   `PLATFORM_ADMIN_API_KEY` → tout en sortie.

Le snippet `<script>` est directement utilisable. Le Hub persiste
`api_key` chiffré dans sa table `tenants` (jamais ré-affichable).

## Sécurité — checklist

- ✅ Guard fail-closed si `PLATFORM_ADMIN_API_KEY` unset (warning loggé)
- ✅ Comparaison timing-safe (`crypto.timingSafeEqual` + padding)
- ✅ Pas de log du Bearer (uniquement "Invalid Authorization header" / "Invalid platform admin API key")
- ✅ Snippet public NE contient JAMAIS l'API key (séparation tracker collect vs server-to-server)
- ✅ Password owner aléatoire 32 bytes — jamais loggé, jamais retourné
- ✅ Email envoyé en best-effort : pas de DoS si SMTP down (le Hub peut retry)
- ⏳ Audit log de chaque appel : **À AJOUTER** (créer entrée dans `audit_logs` table avec `actor='platform-admin'`). Non bloquant pour V1, ticket à poser.

## Points à valider en staging AVANT promo main

1. `curl … /api/admin/platform/tenants.provision` retourne 401 sans Bearer
2. Idem avec mauvais Bearer
3. Idem si `PLATFORM_ADMIN_API_KEY` non configuré (vérifier log warning)
4. Provisioning happy path : workspace + user + api_key persistés en ClickHouse
5. Email magic-link arrive bien dans la boîte du owner (test SMTP staging)
6. Snippet copy/paste sur un site test ; tracker collecte sans erreur CORS
7. Re-appel même email → 409
8. Slug collision : provisionner 2 tenants avec le même `name` → suffixe `_2`

## Ce qui reste à câbler après cette PR

- [x] **Côté bridge** : `getAdminToken` (super_admin pwd+JWT) SUPPRIMÉ
      (2026-06-16, Lot B). Le bridge tape `tenants.provision` /
      `workspaces.provisionApiKey` / `analytics.query` en M2M. Config bridge :
      `STAMINADS_ADMIN_EMAIL`/`STAMINADS_ADMIN_PASSWORD` retirés →
      `PLATFORM_ADMIN_API_KEY`.
- [ ] **Côté Hub** : remplacer son propre client legacy (`x-admin-key` vers
      `analytics.app.veridian.site`) par un fetch vers
      `/api/admin/platform/tenants.provision` (Lot A — ticket croisé Hub).
- [ ] **Côté skill `analytics-provision`** : idem, simplifier le flow.
- [ ] **Côté Dokploy** : ajouter `PLATFORM_ADMIN_API_KEY` (même valeur) dans
      le compose Engine `RH8yiQGFLxTzVXtrvlNmB` (name `analytics-engine-prod`,
      projet `analytics-engine-prod-gkggyk`) ET dans le compose bridge (même
      compose). ⚠️ `Ri8lnog40Jgxn5xWOhaQg` = compose du **LEGACY** Next.js
      (`analytics.app.veridian.site`), PAS l'engine — ne pas confondre.
      ⚠️ DÉPLOIEMENT : poser l'ENV AVANT de déployer le bridge migré, sinon
      `validateConfig` fail-closed le crashe au boot (cf [[feedback_env_wire_compose_same_commit]]).
- [ ] **Côté bridge `phone-source-dim` agent** : confirmer l'endpoint exact (`POST /api/admin/tenant/:wsId/phone-numbers` assumé ici). Adapter si nécessaire.
- [ ] **Audit log** : ticket P2 à ouvrir — chaque provisioning doit
      laisser une trace dans `audit_logs` (qui a appelé, quel tenant créé).
- [ ] **Reuse-existing-user flow** (V2) : si Robert valide, retirer le 409
      pour permettre l'attache d'un nouveau workspace à un user existant.
