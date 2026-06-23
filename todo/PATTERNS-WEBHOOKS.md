# Patterns engine à respecter pour le module Webhooks

> Document d'orientation pour les agents qui implémenteront les webhooks
> (cf `2026-06-02-webhooks-destinations-multi-tenant.md`).
> Audit fait 2026-06-03 par agent legacy. Lis CE fichier en premier.

---

## TL;DR — ce qu'on RÉUTILISE, ce qu'on N'INTRODUIT PAS

| Besoin | À réutiliser (déjà dans le repo) | À NE PAS introduire |
|---|---|---|
| Auth Bearer scoped workspace | `WorkspaceAuthGuard` + API keys via `passport-http-bearer` | nouveau système d'auth |
| Permission RBAC | `@RequirePermission('webhook.create')` + `permissions.ts` | rôles ad-hoc |
| Storage | **ClickHouse `staminads_system`** (comme `api_keys`, `workspaces`) | Postgres bridge (le bridge sert juste à `Tenant/Site/FormSubmission`) |
| Migrations | `api/src/migrations/v7-webhooks-migration.ts` + registry | knex/migrations brutes |
| Dispatch async post-ingestion | `EventEmitter2` + `@OnEvent('event.tracked')` | BullMQ / pg-boss / Redis |
| Worker retry/delivery | `@nestjs/schedule` `@Cron` + table `webhook_deliveries` | nouvelle infra queue |
| Templating transform | `handlebars` (déjà en deps) | Liquid (à ajouter sans raison) |
| Génération ID | `nanoid` (utility `generateId` dans `common/crypto.ts`) | uuid v4 brut |
| Hash de secret | `hashToken` dans `common/crypto.ts` | crypto.subtle ad-hoc |
| Routes naming | `@Post('webhooks.create')` (point-séparé) | `@Post('/webhooks')` REST classique |
| Doc API | `@ApiOperation` + `@ApiSecurity` + `npm run openapi:generate` | écrire OpenAPI à la main |
| Rate limiting | `@nestjs/throttler` déjà installé | nouveau bucket Redis |
| Tests unit | **Jest** (`*.service.spec.ts`) — PAS Vitest | Vitest |
| Tests E2E | **Jest** `test/jest-e2e.json` avec ClickHouse DB `staminads_test` | Playwright contre staging |
| Dedup events | pattern `dedup_token` déjà utilisé dans `session-payload.handler` | nouveau mécanisme |

**Le ticket initial mentionnait Vitest / Liquid / Postgres / BullMQ / pg-boss → ces choix sont FAUX. Reste sur la stack du repo.**

---

## 1. Auth — réutiliser `WorkspaceAuthGuard` + API keys

L'engine a déjà un système d'API keys complet (`api/src/api-keys/`). Une
API key est :
- Liée à un `workspace_id` (validé par `WorkspaceAuthGuard`)
- A un rôle (`ApiKeyRole`) → check via `hasPermission()`
- Stockée hashed (`key_hash`), prefix visible (`key_prefix`) pour debug
- Soumise à failed-attempts tracking

**Le webhook est protégé exactement comme `workspaces.*`** :

```ts
@Controller('api')
@ApiTags('webhooks')
@ApiSecurity('api-key')
@UseGuards(WorkspaceAuthGuard)
export class WebhooksController {
  @Post('webhooks.create')
  @RequirePermission('webhook.write')
  @ApiOperation({ summary: 'Create a webhook destination for a workspace' })
  create(@Req() req, @Body() dto: CreateWebhookDto) {
    return this.webhooksService.create(dto, req.user.workspace_id);
  }
}
```

Le `WorkspaceAuthGuard` extrait `workspace_id` du body / query auto.
**Tu n'as pas à le coder.** Le guard valide aussi qu'une API key ne peut
agir QUE sur son workspace lié → isolation cross-tenant native.

**Nouvelles permissions à ajouter dans `permissions.ts`** :
- `webhook.read` (viewer+)
- `webhook.write` (admin+)
- `webhook.delete` (admin+)
- `webhook.test` (admin+)

---

## 2. Naming des routes — `webhooks.action`

Convention du repo : routes sous `/api/<resource>.<action>`. Donc :

| Endpoint | Méthode |
|---|---|
| `webhooks.list` | GET (query `workspace_id`) |
| `webhooks.get` | GET (query `workspace_id` + `id`) |
| `webhooks.create` | POST |
| `webhooks.update` | POST (PATCH-style, body `id` + champs) |
| `webhooks.delete` | POST (body `id`, soft-delete) |
| `webhooks.test` | POST (body `id`, retourne sync le résultat) |
| `webhooks.deliveries.list` | GET (query `webhook_id` + filtres) |
| `webhooks.deliveries.retry` | POST (body `delivery_id`) |
| `webhooks.events` | GET (query `workspace_id` → liste events disponibles) |

PAS `/api/workspaces/{id}/webhooks` REST-classique — ce n'est PAS la
convention du repo.

---

## 3. Storage — ClickHouse `staminads_system`

Les tables système (workspaces, users, api_keys, audit_logs) vivent
toutes dans la DB ClickHouse `staminads_system`. **C'est là que vont les
webhooks**, PAS dans Postgres bridge.

### Migration à créer

`api/src/migrations/v7-webhooks-migration.ts` (vérifier le prochain
numéro libre avant) :

```ts
export const v7WebhooksMigration: Migration = {
  version: 7,
  description: 'Add webhook_definitions and webhook_deliveries tables',
  async up(clickhouse) {
    await clickhouse.exec(`
      CREATE TABLE IF NOT EXISTS staminads_system.webhook_definitions (
        id              String,
        workspace_id    String,
        name            String,
        url             String,
        active          UInt8 DEFAULT 1,
        auth_type       String,        -- 'bearer' | 'basic' | 'hmac' | 'none'
        auth_secret     String,        -- encrypted (AES-256-GCM)
        events          String,        -- JSON array
        filters         String,        -- JSON array
        transform       String,        -- JSON object or empty
        retry_config    String,        -- JSON object
        created_at      DateTime DEFAULT now(),
        updated_at      DateTime DEFAULT now(),
        deleted_at      Nullable(DateTime)
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY (workspace_id, id)
    `);

    await clickhouse.exec(`
      CREATE TABLE IF NOT EXISTS staminads_system.webhook_deliveries (
        id                String,
        webhook_id        String,
        workspace_id      String,
        event_id          String,
        event_type        String,
        attempt           UInt8 DEFAULT 1,
        scheduled_at      DateTime,
        sent_at           Nullable(DateTime),
        status            String,      -- 'pending'|'success'|'failed'|'retrying'|'gave_up'
        http_status       Nullable(UInt16),
        latency_ms        Nullable(UInt32),
        request_url       String,
        request_body      String,      -- truncated >64KB
        response_body     String,      -- truncated >64KB
        error_message     String,
        created_at        DateTime DEFAULT now()
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(created_at)
      ORDER BY (workspace_id, webhook_id, created_at)
      TTL created_at + INTERVAL 30 DAY DELETE
    `);
  },
  async down(_clickhouse) { /* idempotent rollback */ }
};
```

Note ClickHouse : pas de FOREIGN KEY, pas d'UNIQUE constraint. L'unicité
`(workspace_id, name)` est appliquée **côté service** au moment du
`create()` (SELECT puis throw `ConflictException`).

---

## 4. Dispatch async — `EventEmitter2`

Pattern déjà en place. `EventsController.track()` peut émettre un event
après écriture ClickHouse :

```ts
// dans session-payload.handler.ts (existant, à étendre)
await this.clickhouse.insertEvents(...);
this.eventEmitter.emit('event.tracked', {
  workspace_id,
  event_type: 'pageview',
  visitor_id,
  payload: { path, utm, ... },
  event_id: dedupToken,
});
```

```ts
// dans webhooks/webhook-dispatcher.service.ts (nouveau)
@OnEvent('event.tracked')
async dispatchToWebhooks(event: TrackedEvent) {
  const webhooks = await this.webhooksService.findActive(event.workspace_id);
  for (const wh of webhooks) {
    if (this.filterEngine.matches(wh.filters, event)) {
      await this.webhooksService.enqueueDelivery(wh, event);
    }
  }
}
```

`enqueueDelivery` = INSERT dans `webhook_deliveries` avec
`status='pending'`, `scheduled_at=NOW()`.

---

## 5. Worker delivery — `@nestjs/schedule` cron

Pas besoin de BullMQ. Le repo a déjà :
- `subscription-scheduler.service.ts` : `@Cron('0 */15 * * * *')` qui
  tourne toutes les 15 min — c'est le modèle à reproduire.

```ts
// dans webhooks/webhook-delivery-worker.service.ts (nouveau)
@Injectable()
export class WebhookDeliveryWorker {
  // toutes les 10 secondes : poll pending/retrying
  @Interval(10_000)
  async drainQueue() {
    const pending = await this.deliveriesRepo.findReadyToSend(50); // batch
    await Promise.all(pending.map(d => this.deliverOne(d)));
  }

  private async deliverOne(delivery: WebhookDelivery) {
    const wh = await this.webhooksService.findById(delivery.webhook_id);
    const body = this.transformEngine.render(wh.transform, delivery.payload);
    try {
      const res = await fetch(wh.url, {
        method: 'POST',
        headers: this.buildAuthHeaders(wh),
        body,
        signal: AbortSignal.timeout(10_000),
      });
      await this.markSuccess(delivery, res);
    } catch (err) {
      await this.scheduleRetry(delivery, err);
    }
  }
}
```

Pas de Redis, pas de BullMQ. **`@Interval(10_000)` + batch SELECT suffit
pour la V1**.

Si plus tard le volume explose (> 100 webhooks delivery/sec) → on
introduit BullMQ. Pas avant.

---

## 6. Tests — Jest (pas Vitest)

`api/package.json` :
- `test` → `jest` (unit, `*.spec.ts`)
- `test:e2e` → `CLICKHOUSE_DATABASE=staminads_test jest --config test/jest-e2e.json`

Structure :
- `api/src/webhooks/webhooks.service.spec.ts` (unit, mock ClickHouse)
- `api/src/webhooks/webhook-filter-engine.spec.ts` (unit pur)
- `api/src/webhooks/webhook-transform-engine.spec.ts` (unit pur)
- `api/src/webhooks/webhook-crypto.spec.ts` (unit pur)
- `api/src/webhooks/webhook-ssrf-guard.spec.ts` (unit pur)
- `api/src/webhooks/webhook-delivery-worker.spec.ts` (unit, mock fetch)
- `api/test/webhooks.e2e-spec.ts` (E2E CRUD + dispatch + multi-tenant)
- `api/test/webhook-ssrf.e2e-spec.ts` (E2E security)

Mock server HTTP : créer `api/test/utils/mock-webhook-target.ts` (Express
sur port aléatoire), réutilisable.

Coverage cible : `> 80%` sur le module `webhooks/` (le repo utilise
`test:cov` + `coverage:merge` pour fusionner unit + e2e).

**Le test-mapping pre-push exige** : chaque `*.ts` source touché doit
avoir un `*.spec.ts` correspondant. Cf
`scripts/ci/check-test-mapping.sh`. Ne push pas un `webhooks.service.ts`
sans `webhooks.service.spec.ts`.

---

## 7. Templating — handlebars (déjà installé)

Le repo a `handlebars: ^4.7.8` (utilisé pour les emails MJML). Réutilise.

```ts
import * as Handlebars from 'handlebars';

const template = Handlebars.compile(webhook.transform.template);
const body = template({
  event_type: event.type,
  email: event.email,
  path: event.path,
  utm: event.utm,
  // ...
});
```

Helpers à enregistrer :
- `{{json this}}` pour rendre un objet en JSON
- `{{default email "anonymous"}}` pour fallback
- `{{lowercase email}}` etc.

Pas besoin de Liquid. Pas besoin d'ajouter de dep.

---

## 8. Chiffrement secrets — pattern à créer

Le repo n'a PAS de KMS managé. Pour le `auth_secret` des webhooks :

**V1 minimum viable** : AES-256-GCM avec clé maître dans
`WEBHOOK_ENCRYPTION_KEY` (ENV, 32 bytes hex). Helper dans
`common/crypto.ts` :

```ts
export function encryptSecret(plaintext: string): string {
  // returns "iv:authTag:ciphertext" en base64
}
export function decryptSecret(encrypted: string): string { ... }
```

À ajouter dans `.env.example` (le pre-push check `check-env-sync`
refusera sinon).

**Rotation** : pas implémentée en V1. Ouvrir ticket `webhooks-key-rotation.md`.

---

## 9. SSRF allowlist

Helper `common/ssrf-guard.ts` (`SsrfGuard`, pur + testable) qui REFUSE :
- `localhost`, `127.0.0.0/8`, `0.0.0.0`
- Private IPs : `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, CGNAT `100.64.0.0/10`
- Link-local : `169.254.0.0/16` (metadata cloud !)
- `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:<privée>`
- Schemes non-https en prod (sauf flag `WEBHOOK_ALLOW_HTTP=true` staging)
- URLs vers l'engine lui-même (pattern `analytics-engine.*\.veridian\.site`)
  → anti-boucle infinie

**Deux couches (implémenté 2026-06-23, tickets SSRF clos)** :
1. `assertSafeUrl()` — SYNC, check littéral du hostname. Au CRUD (create/update),
   feedback immédiat, zéro DNS.
2. `assertSafeUrlResolved()` — ASYNC, **résout le hostname et rejette si UNE IP
   résolue est privée/loopback/link-local/metadata**. Appelé AVANT chaque fetch
   sortant (delivery + `webhooks.test` + Twenty) depuis `sendOne()` (point de
   passage unique). Ferme le trou "evil.com passe le check littéral puis pointe
   sur 127.0.0.1" + le DNS-rebinding post-création.

Le worker fetch en `redirect: 'manual'` et **rejette tout 3xx** (un endpoint
public peut sinon 302 → IP interne). Rejets SSRF/redirect = terminaux (no retry).

**Résiduel TOCTOU** : un rebinding sub-seconde entre notre resolve et le connect
d'undici n'est pas pinné (le `fetch` global Node n'accepte pas de `lookup`
custom sans dispatcher undici externe — pas de dep ajoutée). Fenêtre étroite,
neutralisée en pratique par le check toutes-IP + `redirect: 'manual'`.

---

## 10. Rate limiting

`@nestjs/throttler` est déjà installé. Appliquer :

```ts
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Post('webhooks.test')
test(...) { ... }
```

→ 60 tests par minute par workspace API key.

Pour le rate limiting **côté livraison** (ne pas DDOS la destination
client), pattern :
- max 100 deliveries/sec par webhook
- si dépassé, on diffère (UPDATE `scheduled_at = NOW() + 1s` sur les
  next dans la queue)

Détail à fignoler en Phase 2.

---

## 11. Pièges déjà observés sur le repo

- **Prisma generate manquant dans worktrees** : si tu touches au bridge,
  fais `cd veridian-bridge && npx prisma generate` AVANT pre-push, sinon
  `tsc` plante (mémoire `feedback_agent_traps_2026-05-25`)
- **Husky strict** : pas de `--no-verify`. Mode `sdk-only` ne s'applique
  pas ici (tu touches `api/`). Mode complet (5-10 min en cold install).
- **Trunk-based staging** : pas de branche `feat/*`, tout sur `staging`,
  push direct. Promo `staging → main` via `gh api PATCH /git/refs/heads/main`
  (l'auto-promote n'est pas câblé sur engine).
- **Sous-agents Opus uniquement** (cf `feedback_subagents_opus_only`).
- **Aucun build/test local** (RAM 7.6Gi) : tout sur dev-pub ou CI cloud.
- **Migrations ClickHouse** : pas de DROP COLUMN tier 💀 sans accord
  Robert (cf §20.4 CI-ARCHITECTURE). Nos ajouts (CREATE TABLE) = tier
  🟡 MOYEN, agent peut promote autonome après E2E.

---

## 12. Workflow recommandé pour le ticket Phase 1

L'agent qui prend Phase 1 doit faire **dans cet ordre** :

1. Lire CE document + ticket parent
2. Créer la migration ClickHouse `v7-webhooks-migration.ts` + ajouter
   au registry → test up/down sur staging
3. Créer entities (`webhook-definition.entity.ts`, `webhook-delivery.entity.ts`)
4. Créer DTOs avec class-validator (`create-webhook.dto.ts`, etc.)
5. Service `WebhooksService` : CRUD + finders + filter eval
6. Controller `WebhooksController` avec routes `webhooks.*`
7. `WebhookDispatcherService` (`@OnEvent('event.tracked')`)
8. Hook dans `session-payload.handler.ts` pour émettre l'event après
   insert ClickHouse
9. `WebhookDeliveryWorker` (`@Interval(10_000)`)
10. Permissions dans `permissions.ts`
11. Module `WebhooksModule` + register dans `app.module.ts`
12. Tests unit (8 fichiers) + E2E (2 fichiers)
13. `npm run openapi:generate` → vérifier que les nouvelles routes
    apparaissent dans le swagger
14. Doc `docs/AGENT-COOKBOOK-WEBHOOKS.md`
15. Smoke staging : créer un webhook, déclencher un track, vérifier la
    delivery dans la table
16. Push staging, watch CI, promote main via gh api

---

## 13. Critère d'arrêt Phase 1

**Quand peut-on promote staging→main et passer à Phase 2 ?**

- Tous les endpoints `webhooks.*` répondent (Swagger UI les liste)
- CRUD complet via curl + Bearer marche
- E2E smoke : POST /api/track sur staging → delivery insérée → worker
  la pousse vers un mock server → delivery `status=success` en DB
- Multi-tenant : 2 workspaces, isolation prouvée
- Coverage > 80% sur `api/src/webhooks/`
- Doc agent cookbook livrée
- CI staging engine 100% verte
