# Twenty CRM — native destination (design B)

The Twenty connector turns the webhooks module into a native Twenty CRM
destination (modèle Segment/PostHog), replacing the timeline path of the
`veridian-tunnel-de-vente/bridge` micro-service. Cf CONTRATS-TUNNEL §4c +
ticket `todo/2026-06-02-webhooks-destinations-multi-tenant.md` (Phase 4).

## What it does (and what it does NOT)

- ✅ **Timeline activities** — maps analytics events to Twenty timeline
  activities (`audit.page_view | audit.scroll | audit.cta_click | audit.rdv |
  signup | app.started`), resolves the target Person, batches ≤60 per call,
  respects the ≤100 req/min budget. Event-driven, native.
- ❌ **person.score** — the engine NEVER writes the score. The bridge tunnel is
  the single score authority (it fuses Notifuse signals + uses a compare-and-set).
  Writing the score here would break the "2 clics = 30 = chaud" invariant and
  create a double-writer lost-update (team-lead decision, CONTRATS-TUNNEL §4c.4).
  The engine only EXPOSES analytics aggregates (separate endpoint, task #5).

## Files

| File | Role |
|---|---|
| `twenty-event-mapper.ts` | pure: tracked event → timeline name + identity + happensAt |
| `twenty-client.ts` | pure I/O: resolve Person (email/slug), batch timeline. DRY_RUN aware. NO score write. |
| `twenty-budget.ts` | sliding-minute token bucket (≤100 req/min, §4c.2) |
| `twenty-connector.service.ts` | orchestration: map → resolve (cached) → batch → classify deliveries |

The `WebhookDeliveryWorker` routes a webhook to the connector when its
`transform.type === 'twenty'` (else the generic 1:1 POST path is used).

## Provision a Twenty destination (API, no UI)

```bash
curl -X POST "$ENGINE/api/webhooks.create" \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "vrd_veridian_site_prod",
    "name": "Twenty CRM",
    "url": "https://crm.app.veridian.site",     // Twenty REST base URL
    "auth": { "type": "bearer", "token": "<TWENTY_API_KEY>" },  // encrypted at rest
    "events": ["goal", "screen_view"],
    "transform": { "type": "twenty", "dry_run": true }  // gate à blanc
  }'
```

- `url` = the Twenty REST base URL (the connector appends `/rest/...`).
- `auth.token` = the Twenty Bearer, stored encrypted (webhook-crypto). Never
  returned by GET.
- `transform.dry_run: true` (or env `TWENTY_CONNECTOR_DRY_RUN=true`) → Person
  resolution stays real, timeline writes are logged not sent. Flip to `false`
  after the gate proves the mapping.

## Delivery outcomes

| Connector outcome | Delivery status | Why |
|---|---|---|
| written | success | timeline activity batched (or dry-run accepted) |
| skipped | success (no-op) | not a timeline milestone — never retried |
| orphan | retrying (5 min backoff) | Person not found yet (import batch may run later) |
| failed | retrying / gave_up | mapping/budget/batch error — webhook retry policy |

## Idempotence

`happensAt` is the TRUE event time (ISO UTC) and `properties.eventId` carries
the stable tracked-event id, so replaying the same event produces a
byte-identical activity → Twenty-side dedup is deterministic.

## Anti-loop / SSRF

The shared SSRF guard (`common/ssrf-guard.ts`, `SsrfGuard`) refuses a `url`
pointing at the engine itself or at private/loopback addresses, on both create
and delivery. The same guard protects the public `tools/` fetch endpoints.
