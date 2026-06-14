# Webhooks destinations multi-tenant — produit SaaS pilotable par API

> **Sévérité** : 🟡 P1 — feature commercialisable, pas un câblage interne
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-02
> **Demandeur** : Robert
> **Spec parent** : [`veridian-platform/TUNNEL-DE-VENTE.md`](../../veridian-platform/TUNNEL-DE-VENTE.md) §3.2-3.3 + §6 étape 7
> **Remplace** : ticket `2026-06-02-engine-router-crm-twenty.md` (supprimé — trop spécifique)
> **LIRE EN PREMIER** : [`PATTERNS-WEBHOOKS.md`](./PATTERNS-WEBHOOKS.md)
> (audit engine 2026-06-03 — choix techniques à respecter, sinon tu réinventes la roue)

---

## ⚠️ Choix techniques figés par l'audit engine (PATTERNS-WEBHOOKS.md)

La V1 de ce ticket parlait de Vitest / Liquid / Postgres / BullMQ / pg-boss.
**FAUX**. La stack engine impose :

- **Tests** : Jest (pas Vitest)
- **Templating** : Handlebars (déjà installé, pas Liquid)
- **Storage** : ClickHouse `staminads_system` (pas Postgres bridge)
- **Queue/Worker** : `EventEmitter2` + `@nestjs/schedule @Interval`
  (pas BullMQ, pas pg-boss)
- **Auth** : `WorkspaceAuthGuard` + API keys existantes (pas nouveau système)
- **Templating ID** : `nanoid` via helper `generateId` (déjà là)
- **Routes naming** : `webhooks.action` (point-séparé, convention repo)

Le reste du ticket (spec API, schéma logique, tests, phases) reste valide
**MODULO** ces substitutions. PATTERNS-WEBHOOKS.md donne le pas-à-pas
d'implémentation exact.

---

## Vision

L'engine reçoit déjà les events via `/api/track`. On en fait un **routeur** :
chaque workspace peut configurer N webhooks pour fan-out ses events vers
ses propres destinations (CRM, Slack, n8n, Zapier, HubSpot…). Modèle
**Segment / Rudderstack / PostHog destinations**.

Aujourd'hui Veridian utilise ça pour pousser ses leads dans Twenty.
Demain, **chaque client SaaS Veridian Analytics** peut activer ses
propres automatisations.

Argument commercial : ce n'est plus "un analytics", c'est "un analytics
qui déclenche tes workflows".

## Principes non négociables

### 1. API-first

**Toute la feature doit être pilotable par API REST + Bearer.**
Aucune action UI qui n'ait pas son équivalent API. Raisons :

- Les agents IA (Claude Code + autres) doivent pouvoir provisionner /
  configurer / tester / debug les webhooks d'un workspace **sans cliquer**
- Les clients power-users veulent scripter leur setup
- Tests E2E machine-to-machine

L'UI Settings du workspace est un wrapper visuel sur ces endpoints.

### 2. Multi-tenant strict

Chaque webhook appartient à **un** workspace. Aucune fuite cross-tenant.
La table `webhook_definitions` a `workspace_id NOT NULL`, scoped sur
toutes les queries. Tests d'isolation obligatoires.

### 3. Best-effort, jamais bloquant

Le push webhook ne doit JAMAIS bloquer la réponse `/api/track` au SDK.
Async (queue + worker), fire-and-forget côté SDK, retry côté worker.

### 4. Traçabilité totale

Chaque tentative de delivery est loggée (table `webhook_deliveries`)
avec : timestamp, URL cible, status HTTP, latence, request body, response
body, error. Conservation 30j minimum, configurable.

### 5. Sécurité

- Pas d'URL en HTTP en clair (HTTPS obligatoire en prod, sauf override
  staging/dev)
- Allowlist anti-SSRF : refus de URL vers `localhost`, `127.0.0.1`,
  `169.254.*`, `10.*`, `192.168.*` en prod sauf flag explicite
- Secrets (Bearer token, HMAC key) stockés chiffrés en DB
  (KMS / AES-256 — réutiliser le mécanisme existant du repo si présent,
  sinon utiliser `crypto` natif avec clé maître en ENV)
- Logs `request_body` tronqués ou hash si trop volumineux

## API REST complète

Base : `https://analytics-engine.app.veridian.site/api/workspaces/{workspace_id}/webhooks`

Auth : `Authorization: Bearer <WORKSPACE_API_KEY>` (clé scoped au workspace,
à provisionner via un autre endpoint admin)

### Endpoints

#### `POST /webhooks` — créer un webhook

Body :
```json
{
  "name": "Mon CRM Twenty",
  "url": "https://crm.app.veridian.site/api/webhooks/analytics",
  "active": true,
  "auth": {
    "type": "bearer",  // "bearer" | "basic" | "hmac" | "none"
    "token": "secret_xxx"  // jamais retourné dans GET
  },
  "events": ["identify", "pageview", "form_submission"],
  "filters": [
    { "field": "path", "op": "matches", "value": "^/(audit|pricing|contact)$" },
    { "field": "utm.source", "op": "equals", "value": "google_ads" }
  ],
  "transform": {
    "type": "template",  // "template" | "passthrough"
    "engine": "liquid",
    "template": "{ \"source\": \"veridian\", \"event\": \"{{ event_type }}\", \"email\": \"{{ email }}\", \"path\": \"{{ path }}\" }"
  },
  "retry": {
    "max_attempts": 3,
    "backoff_ms": [60000, 300000, 900000]
  }
}
```

Réponse `201` :
```json
{
  "id": "wh_abc123",
  "workspace_id": "vrd_veridian_site_prod",
  "name": "Mon CRM Twenty",
  "url": "https://crm.app.veridian.site/api/webhooks/analytics",
  "active": true,
  "events": ["identify", "pageview", "form_submission"],
  "auth": { "type": "bearer" },  // token MASQUÉ
  "created_at": "2026-06-02T16:00:00Z",
  "updated_at": "2026-06-02T16:00:00Z",
  "last_delivery_status": null
}
```

#### `GET /webhooks` — lister les webhooks du workspace

#### `GET /webhooks/{id}` — détail (token masqué)

#### `PATCH /webhooks/{id}` — update partiel
Champs autorisés : `name`, `url`, `active`, `auth`, `events`, `filters`,
`transform`, `retry`. Update du token via ce même endpoint (chiffré).

#### `DELETE /webhooks/{id}` — supprimer (soft delete)

#### `POST /webhooks/{id}/test` — déclenche un event de test

Body optionnel `{ "event": {...payload custom...} }`. Sinon utilise un
payload bidon. Renvoie le résultat de l'envoi (status HTTP, body destination,
latence) **immédiatement** (synchrone uniquement pour ce endpoint, pas async).

Réponse :
```json
{
  "delivery_id": "del_xyz",
  "success": true,
  "http_status": 200,
  "latency_ms": 124,
  "response_body": "{\"received\":true}"
}
```

#### `GET /webhooks/{id}/deliveries` — historique deliveries

Query : `?limit=50&status=failed&since=2026-06-01`

#### `POST /webhooks/{id}/deliveries/{delivery_id}/retry` — retry manuel

Pour rejouer une delivery échouée.

#### `GET /webhook-events` — événements disponibles dans CE workspace

Pour l'UI : liste des event_types et leurs schémas pour qu'un user/agent
sache quoi filtrer. Réponse :
```json
{
  "events": [
    { "type": "pageview", "schema": { "path": "string", "utm": "object", ... } },
    { "type": "identify", "schema": { "email": "string", "user_id": "string?" } },
    { "type": "form_submission", "schema": {...} },
    { "type": "appointment_click", "schema": {...} }
  ]
}
```

### Code d'erreur API

| HTTP | Code | Sens |
|---|---|---|
| 400 | `INVALID_URL` | URL malformée ou non-HTTPS en prod |
| 400 | `INVALID_FILTER` | Filtre mal formé |
| 400 | `INVALID_TRANSFORM` | Template Liquid non parsable |
| 401 | `UNAUTHORIZED` | Pas de Bearer ou Bearer invalide |
| 403 | `FORBIDDEN_TARGET` | URL bloquée par allowlist anti-SSRF |
| 404 | `WEBHOOK_NOT_FOUND` | id inexistant ou hors workspace |
| 409 | `DUPLICATE_NAME` | Un webhook avec ce nom existe déjà |
| 429 | `RATE_LIMITED` | Trop de requêtes (limite par workspace) |
| 500 | `INTERNAL_ERROR` | Bug serveur |

## Schéma DB (Postgres bridge)

```sql
CREATE TABLE webhook_definitions (
  id              VARCHAR PRIMARY KEY,  -- "wh_<nanoid>"
  workspace_id    VARCHAR NOT NULL REFERENCES workspaces(id),
  name            VARCHAR NOT NULL,
  url             TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  auth_type       VARCHAR NOT NULL,         -- 'bearer' | 'basic' | 'hmac' | 'none'
  auth_secret     TEXT,                     -- AES-256 encrypted
  events          JSONB NOT NULL,           -- ["pageview", ...]
  filters         JSONB NOT NULL DEFAULT '[]',
  transform       JSONB,
  retry_config    JSONB NOT NULL DEFAULT '{"max_attempts":3,"backoff_ms":[60000,300000,900000]}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (workspace_id, name) WHERE deleted_at IS NULL
);

CREATE INDEX idx_webhooks_workspace_active ON webhook_definitions(workspace_id)
  WHERE active = true AND deleted_at IS NULL;

CREATE TABLE webhook_deliveries (
  id                VARCHAR PRIMARY KEY,    -- "del_<nanoid>"
  webhook_id        VARCHAR NOT NULL REFERENCES webhook_definitions(id),
  workspace_id      VARCHAR NOT NULL,       -- denorm pour query rapide
  event_id          VARCHAR NOT NULL,       -- propagation idempotence
  event_type        VARCHAR NOT NULL,
  attempt           INT NOT NULL DEFAULT 1,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  sent_at           TIMESTAMPTZ,
  status            VARCHAR NOT NULL,       -- 'pending' | 'success' | 'failed' | 'retrying' | 'gave_up'
  http_status       INT,
  latency_ms        INT,
  request_url       TEXT,
  request_body      JSONB,                  -- truncated if > 64KB
  response_body     TEXT,                   -- truncated if > 64KB
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX idx_deliveries_pending ON webhook_deliveries(scheduled_at)
  WHERE status IN ('pending', 'retrying');
CREATE INDEX idx_deliveries_workspace ON webhook_deliveries(workspace_id, created_at DESC);
```

Rétention `webhook_deliveries` : 30j par défaut, configurable par
workspace. Cron de cleanup quotidien.

## Architecture runtime

```
┌─────────────────────────────────────────────────────────────┐
│  POST /api/track (SDK ingestion)                            │
│   1. Validate payload                                       │
│   2. Write ClickHouse (events)                              │
│   3. Async dispatch :                                       │
│      ├─ SELECT webhooks WHERE workspace_id=X AND active     │
│      ├─ Pour chaque webhook : evaluate filters              │
│      ├─ Si match : INSERT webhook_deliveries (status=pending│
│      │             scheduled_at=NOW())                       │
│      └─ Return 200 au SDK (delivery async)                  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Worker webhook-delivery (BullMQ ou pg-boss)                │
│   - Poll webhook_deliveries WHERE status IN ('pending',     │
│     'retrying') AND scheduled_at <= NOW()                   │
│   - Apply transform (Liquid template)                       │
│   - HTTP POST → URL avec auth                               │
│   - On success : UPDATE status='success', http_status,...   │
│   - On 5xx/timeout :                                        │
│       - attempt < max : status='retrying',                  │
│         scheduled_at = NOW() + backoff_ms[attempt]          │
│       - sinon : status='gave_up'                            │
│   - On 4xx (sauf 429) : status='failed' direct (pas retry)  │
│   - On 429 : retry comme 5xx                                │
└─────────────────────────────────────────────────────────────┘
```

## Tests obligatoires

### Tests unitaires (Vitest) — coverage > 80% sur le module webhooks

- `WebhookFilterEngine.test.ts` : 20+ cas de filtre (equals, matches,
  in, gt/lt, AND/OR, champs imbriqués `props.score`, `utm.source`)
- `WebhookTransformEngine.test.ts` : templates Liquid (variables, conditions,
  defaults, escape)
- `WebhookCrypto.test.ts` : chiffrement/déchiffrement secrets (round-trip,
  rotation clé, gestion KMS absent)
- `SsrfGuard.test.ts` : 30+ URL malicieuses (localhost, IPs privées,
  schemes file://, javascript:, redirects malveillants)
- `WebhookDeliveryWorker.test.ts` : retry logic (mock HTTP, simulate
  200/4xx/5xx/timeout, vérifier backoff exact)

### Tests d'intégration (Postgres réel + ClickHouse réel)

- `webhooks.crud.integration.test.ts` : créer, lire, update, soft delete
- `webhooks.dispatch.integration.test.ts` : POST /api/track → vérifier
  qu'une delivery est insérée pour les webhooks qui matchent
- `webhooks.delivery-worker.integration.test.ts` : worker traite delivery
  pending → HTTP POST vers un mock HTTP server → vérifier les retries
- `webhooks.multi-tenant.integration.test.ts` :
  - Workspace A crée webhook → workspace B ne le voit pas (GET retourne [])
  - PATCH/DELETE depuis B sur ID de A → 404 (pas 403, pour ne pas leak
    l'existence)
  - Event dans workspace A ne déclenche pas les webhooks de B

### Tests E2E (Playwright contre engine staging)

- `webhooks-api.e2e.spec.ts` :
  1. Provisionner workspace test (script existant)
  2. POST /webhooks via API → 201
  3. POST /api/track avec un event qui matche → 200
  4. Poll GET /webhooks/{id}/deliveries → délivrance success en < 5s
  5. POST /webhooks/{id}/test → renvoie 200 synchrone avec response
  6. PATCH `active=false` → POST /api/track → AUCUNE delivery créée
  7. DELETE webhook → GET retourne 404
- `webhooks-ssrf.e2e.spec.ts` :
  1. POST /webhooks avec URL `http://localhost:3000` → 403
  2. URL `http://169.254.169.254/` → 403
  3. URL `https://valid.com/path` → 201

### Tests sécurité (à intégrer en CI)

- Tentative cross-tenant via API directe → bloqué
- Bearer scoped à workspace A utilisé sur endpoint workspace B → 401
- Token au repo : zéro secret en clair, gitleaks vert

### Mock HTTP server pour tests

Un petit serveur Express dans `test-utils/mock-webhook-target.ts` qui
écoute sur un port aléatoire, log les requêtes reçues, peut être
configuré pour retourner 200 / 5xx / timeout. Réutilisable pour tous
les tests d'intégration.

## Implémentation par phases

### Phase 1 — Core (P0) — ~2j d'agent

- Schéma DB + migrations
- API CRUD webhooks
- Filter engine simple (`equals`, `matches`, `in`)
- Dispatcher async (insert pending delivery)
- Worker delivery basique (HTTP POST + retry)
- Tests unitaires + 2 tests d'intégration smoke
- Doc API minimale (OpenAPI spec)

### Phase 2 — Production-ready (P1) — ~1j

- Transform engine Liquid
- Endpoint `/test` synchrone
- Endpoint `/deliveries` + retry manuel
- SSRF allowlist
- Chiffrement secrets
- Tests E2E complets
- Rate limiting par workspace (Redis bucket : 100 req/s par defaut)

### Phase 3 — UI Settings (P2) — ~1.5j

- Onglet "Webhooks" dans Settings du workspace (UI staminads native, cf
  CLAUDE.md règle UI native)
- Liste, créer, éditer, tester, voir deliveries
- Pas de page dédiée : un seul onglet Settings comme dictée par la
  vision

### Phase 4 — Destinations natives (P3, futur)

Templates pré-configurés pour des destinations populaires :
- Twenty CRM (mapping vers Person + custom object)
- HubSpot
- Slack (transform vers Slack blocks)
- Discord
- n8n / Zapier / Make (passthrough JSON)

Au lieu de demander à l'utilisateur de remplir le template Liquid,
choisir "HubSpot" dans une dropdown → le template est rempli auto.

## Pilotage par agents IA — pourquoi c'est critique

Les agents Claude Code de Veridian doivent pouvoir, **sans UI** :

1. **Provisionner** un webhook quand on onboard un client client
   ("ajoute un webhook qui pousse les form_submissions vers leur Slack")
2. **Tester** : "envoie un event bidon, vérifie que ça arrive"
3. **Debugger** : "pourquoi le webhook X échoue depuis 2h ?" → query
   `GET /deliveries?status=failed` + lecture des `error_message`
4. **Migrer** : "tous les workspaces avec un webhook HubSpot → bump
   format au nouveau schéma" → script batch via API

Exemple d'usage agent :

```bash
# Skill provisioning client SaaS
curl -X POST $ENGINE/api/workspaces/vrd_acme_prod/webhooks \
  -H "Authorization: Bearer $WORKSPACE_KEY" \
  -d '{
    "name": "Acme Slack alerts",
    "url": "https://hooks.slack.com/services/...",
    "events": ["identify", "appointment_click"],
    "filters": [{"field":"props.score","op":"gt","value":80}],
    "transform": { "type": "template", "engine": "liquid", "template": "..." }
  }'
```

L'API doit retourner des erreurs **structurées** (code + message) pour
que l'agent puisse réagir automatiquement (ex: corriger le template si
`INVALID_TRANSFORM`).

## OpenAPI spec

Livrable obligatoire : un fichier `openapi.yaml` à la racine du module
`api/src/webhooks/` décrivant TOUS les endpoints. Permet :
- Génération client TypeScript / Python pour les agents
- Doc auto via Swagger UI servie sur `/api/webhooks/docs`
- Tests contract (Dredd ou équivalent)

## Quand est-ce fini ?

- [ ] Phase 1 + 2 livrées sur staging engine
- [ ] Tous les tests passent (unit + integration + E2E)
- [ ] Cas multi-tenant prouvé (test E2E qui crée 2 workspaces, vérifie
      isolation)
- [ ] OpenAPI spec publiée et exposée à `/api/webhooks/docs`
- [ ] Doc agent dans `docs/AGENT-COOKBOOK-WEBHOOKS.md` avec recettes
      pour : provisionner, tester, debug, lister deliveries failed,
      migrer N workspaces
- [ ] Smoke prod : workspace `vrd_veridian_site_prod` configuré avec
      un webhook vers Twenty (placeholder), un event réel sur veridian.site
      déclenche une delivery, visible dans la table
- [ ] Promo staging → main, prod healthy

## Risques

- **Sur-engineering UI** : l'UI Settings doit rester un wrapper léger
  sur l'API. Pas de wizard à 5 étapes, pas de form-builder visuel pour
  les filtres. Champ texte JSON + bouton "Valider" suffit en V1.
- **Coût ClickHouse / Postgres** : 1 event = N inserts deliveries selon
  le nombre de webhooks matchants. Limiter à 10 webhooks actifs par
  workspace par défaut (configurable).
- **SSRF** : un webhook mal validé peut servir à scanner le réseau
  interne. Tests SSRF non négociables, code review explicite sur ce point.
- **Secrets en clair** : SI un dev rajoute un log `console.log(webhook)`
  sans masquer, le secret part dans Grafana Logs. Helper `redactSecrets()`
  obligatoire, test qui vérifie qu'il n'y a aucun secret en log.
- **Boucle infinie** : un webhook qui pointe sur `/api/track` du même
  engine. Détecter et bloquer (refuse URL qui matche le pattern engine).

## Notes pour l'agent

- L'engine est en NestJS (cf structure `api/src/`). Module à créer :
  `api/src/webhooks/` avec controllers, services, dto, worker.
- Postgres bridge a déjà Prisma — utiliser le `schema.prisma` pour les
  nouvelles tables.
- Worker delivery : si BullMQ est déjà dans le repo, l'utiliser. Sinon
  pg-boss (plus simple, juste Postgres).
- ClickHouse n'est PAS impacté par ce module (juste lecture pour
  enrichir le payload webhook si besoin de stats sur le visitor)
- Husky fast-path SDK-only ne s'applique pas ici (touche `api/`) →
  pre-push complet, c'est OK.
- Ce ticket est **gros** (~5j de travail). Séquencer par phases. Si
  Phase 1 prend trop de temps, livrer Phase 1 et ouvrir Phase 2 dans
  un ticket séparé.
- Le ticket précédent `2026-06-02-engine-router-crm-twenty.md` est
  remplacé par celui-ci (supprimé). Le besoin "router vers Twenty" sera
  juste un webhook de plus configuré sur le workspace
  `vrd_veridian_site_prod`, pas un câblage dur.
