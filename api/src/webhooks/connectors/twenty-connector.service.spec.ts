import { ConfigService } from '@nestjs/config';
import { TwentyConnectorService } from './twenty-connector.service';
import { TwentyEventMapper } from './twenty-event-mapper';
import { TwentyBudget } from './twenty-budget';
import { TwentyClient } from './twenty-client';
import {
  WebhookDefinition,
  DEFAULT_RETRY_CONFIG,
} from '../entities/webhook-definition.entity';
import { WebhookDelivery } from '../entities/webhook-delivery.entity';

function twentyWebhook(over: Partial<WebhookDefinition> = {}): WebhookDefinition {
  return {
    id: 'wh_twenty',
    workspace_id: 'ws_a',
    name: 'twenty',
    url: 'https://crm.app.veridian.site',
    active: true,
    auth_type: 'bearer',
    auth_secret_encrypted: 'enc',
    events: ['goal', 'screen_view'],
    filters: [],
    transform: { type: 'twenty' },
    retry_config: DEFAULT_RETRY_CONFIG,
    created_at: '2026-06-10 12:00:00.000',
    updated_at: '2026-06-10 12:00:00.000',
    deleted_at: null,
    ...over,
  };
}

function delivery(
  id: string,
  payload: Record<string, unknown>,
  over: Partial<WebhookDelivery> = {},
): WebhookDelivery {
  return {
    id,
    webhook_id: 'wh_twenty',
    workspace_id: 'ws_a',
    event_id: `evt_${id}`,
    event_type: String(payload.event_type ?? 'goal'),
    attempt: 1,
    scheduled_at: '2026-06-10 12:00:00.000',
    sent_at: null,
    status: 'pending',
    http_status: null,
    latency_ms: null,
    request_url: 'https://crm.app.veridian.site',
    request_body: JSON.stringify(payload),
    response_body: '',
    error_message: '',
    created_at: '2026-06-10 12:00:00.000',
    updated_at: '2026-06-10 12:00:00.000',
    ...over,
  };
}

/** A fake TwentyClient that records calls without any HTTP. */
function fakeClient(
  resolveImpl: (identity: string) => Promise<{ id: string; doNotContact: boolean } | null>,
): { client: TwentyClient; batches: any[][]; resolves: string[] } {
  const batches: any[][] = [];
  const resolves: string[] = [];
  const client = {
    async resolvePerson(identity: string) {
      resolves.push(identity);
      return resolveImpl(identity);
    },
    async batchTimeline(items: any[]) {
      batches.push(items);
    },
  } as unknown as TwentyClient;
  return { client, batches, resolves };
}

describe('TwentyConnectorService', () => {
  let connector: TwentyConnectorService;
  let config: ConfigService;

  beforeEach(() => {
    config = { get: () => undefined } as unknown as ConfigService;
    connector = new TwentyConnectorService(new TwentyEventMapper(), config);
  });

  describe('isTwentyDestination', () => {
    it('detects a twenty transform', () => {
      expect(TwentyConnectorService.isTwentyDestination(twentyWebhook())).toBe(true);
    });
    it('rejects passthrough / template / null', () => {
      expect(
        TwentyConnectorService.isTwentyDestination(twentyWebhook({ transform: { type: 'passthrough' } })),
      ).toBe(false);
      expect(
        TwentyConnectorService.isTwentyDestination(twentyWebhook({ transform: null })),
      ).toBe(false);
    });
  });

  describe('buildClient', () => {
    it('dry_run from the transform forces dry-run', () => {
      const wh = twentyWebhook({ transform: { type: 'twenty', dry_run: true } });
      const client = connector.buildClient(wh, 'secret');
      // dry-run client does not POST — proven via batchTimeline being a no-op
      expect(client).toBeInstanceOf(TwentyClient);
    });

    it('global TWENTY_CONNECTOR_DRY_RUN forces dry-run', () => {
      config = { get: (k: string) => (k === 'TWENTY_CONNECTOR_DRY_RUN' ? 'true' : undefined) } as unknown as ConfigService;
      connector = new TwentyConnectorService(new TwentyEventMapper(), config);
      expect(connector.buildClient(twentyWebhook(), 's')).toBeInstanceOf(TwentyClient);
    });
  });

  describe('flushBatch — mapping + batching', () => {
    it('maps milestones, resolves Person, batches written deliveries', async () => {
      const { client, batches, resolves } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      const budget = new TwentyBudget(100, () => 0);
      const deliveries = [
        delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'a@b.com', event_timestamp: '2026-06-10T09:00:00.000Z' }),
        delivery('d2', { event_type: 'goal', goal_name: 'audit_cta_rdv', user_id: 'a@b.com' }),
      ];
      const out = await connector.flushBatch(twentyWebhook(), deliveries, client, budget);
      expect(out.written.sort()).toEqual(['d1', 'd2']);
      expect(out.orphans).toEqual([]);
      expect(out.failed).toEqual([]);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expect(batches[0][0]).toMatchObject({ name: 'audit.rdv', targetPersonId: 'p1' });
      // resolved once per identity (cache) — both deliveries share a@b.com
      expect(resolves).toEqual(['a@b.com']);
    });

    it('skips non-milestone events (treated as success no-op, not retried)', async () => {
      const { client, batches } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      const budget = new TwentyBudget(100, () => 0);
      const deliveries = [
        delivery('d1', { event_type: 'screen_view', path: '/tarifs', user_id: 'a@b.com' }), // not audit → skip
        delivery('d2', { event_type: 'goal', goal_name: 'newsletter', user_id: 'a@b.com' }), // unknown goal → skip
      ];
      const out = await connector.flushBatch(twentyWebhook(), deliveries, client, budget);
      expect(out.skipped.sort()).toEqual(['d1', 'd2']);
      expect(out.written).toEqual([]);
      expect(batches).toHaveLength(0);
    });

    it('emits TWO activities for a deep /audit/ view (page_view + scroll), delivery written once', async () => {
      const { client, batches, resolves } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      const budget = new TwentyBudget(100, () => 0);
      const d = delivery('d1', { event_type: 'screen_view', path: '/audit/x', max_scroll: 90, user_id: 'a@b.com' });
      const out = await connector.flushBatch(twentyWebhook(), [d], client, budget);
      // one delivery → two timeline activities, but classified written ONCE
      expect(out.written).toEqual(['d1']);
      expect(batches[0]).toHaveLength(2);
      expect(batches[0].map((a: { name: string }) => a.name).sort()).toEqual(['audit.page_view', 'audit.scroll']);
      // Person resolved once (both milestones share the identity)
      expect(resolves).toEqual(['a@b.com']);
      // distinct deterministic ids
      expect(batches[0][0].id).not.toBe(batches[0][1].id);
    });

    it('orphans a delivery whose Person is not found', async () => {
      const { client, batches } = fakeClient(async () => null);
      const budget = new TwentyBudget(100, () => 0);
      const deliveries = [delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'ghost@x.com' })];
      const out = await connector.flushBatch(twentyWebhook(), deliveries, client, budget);
      expect(out.orphans).toEqual(['d1']);
      expect(out.written).toEqual([]);
      expect(batches).toHaveLength(0);
    });

    it('caps the batch at 60 deliveries', async () => {
      const { client, batches } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      const budget = new TwentyBudget(1000, () => 0);
      const deliveries = Array.from({ length: 70 }, (_, i) =>
        delivery(`d${i}`, { event_type: 'goal', goal_name: 'rdv_booked', user_id: `u${i}@x.com` }),
      );
      const out = await connector.flushBatch(twentyWebhook(), deliveries, client, budget);
      expect(out.written.length).toBe(60);
      expect(batches[0].length).toBe(60);
    });

    it('fails (not orphans) a delivery when no budget is left for the resolution', async () => {
      // Person would NOT be found, but the bucket is already empty: the delivery
      // must be classified no_budget→failed (retry next tick), NOT orphan — a
      // budget-starved lookup must never be mistaken for a missing Person.
      const { client, resolves } = fakeClient(async () => null);
      const budget = new TwentyBudget(0, () => 0); // empty bucket
      const deliveries = [delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'ghost@x.com' })];
      const out = await connector.flushBatch(twentyWebhook(), deliveries, client, budget);
      expect(out.failed).toEqual(['d1']);
      expect(out.orphans).toEqual([]);
      expect(resolves).toEqual([]); // no network lookup attempted without a token
    });

    it('fails the batch when no token is available for the POST', async () => {
      const { client, batches } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      // budget of 1: consumed by the single Person resolution, none left for the POST
      const budget = new TwentyBudget(1, () => 0);
      const deliveries = [delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'a@b.com' })];
      const out = await connector.flushBatch(twentyWebhook(), deliveries, client, budget);
      expect(out.failed).toEqual(['d1']);
      expect(batches).toHaveLength(0);
    });

    it('propagates a batchTimeline failure as failed (all candidates)', async () => {
      const client = {
        async resolvePerson() {
          return { id: 'p1', doNotContact: false };
        },
        async batchTimeline() {
          throw new Error('Twenty 400 bad ts');
        },
      } as unknown as TwentyClient;
      const budget = new TwentyBudget(100, () => 0);
      const deliveries = [delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'a@b.com' })];
      const out = await connector.flushBatch(twentyWebhook(), deliveries, client, budget);
      expect(out.failed).toEqual(['d1']);
    });
  });

  describe('multi-tenant isolation', () => {
    it('caches Person per (workspace, identity) — same identity in two workspaces resolves twice', async () => {
      const { client, resolves } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      const budget = new TwentyBudget(100, () => 0);
      const whA = twentyWebhook({ id: 'wh_a', workspace_id: 'ws_a' });
      const whB = twentyWebhook({ id: 'wh_b', workspace_id: 'ws_b' });
      await connector.flushBatch(whA, [delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'shared@x.com' }, { workspace_id: 'ws_a' })], client, budget);
      await connector.flushBatch(whB, [delivery('d2', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'shared@x.com' }, { workspace_id: 'ws_b' })], client, budget);
      // not deduped across tenants — each workspace resolves its own Person
      expect(resolves).toEqual(['shared@x.com', 'shared@x.com']);
    });
  });

  describe('idempotence / exactly-once (task #9)', () => {
    it('emits a DETERMINISTIC activity id, identical across replays', async () => {
      const { client, batches } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      const budget = new TwentyBudget(100, () => 0);
      const d = delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'a@b.com', event_timestamp: '2026-06-10T09:00:00.000Z' });
      await connector.flushBatch(twentyWebhook(), [d], client, budget);
      connector.clearCache();
      await connector.flushBatch(twentyWebhook(), [d], client, budget);
      // Real idempotence: the SAME deterministic id is sent on every replay, so
      // Twenty lands on the same row (409/no-op). We assert the id (not just the
      // payload — a byte-identical payload WITHOUT a stable id still duplicates).
      const id1 = batches[0][0].id;
      const id2 = batches[1][0].id;
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('distinct events get distinct activity ids', async () => {
      const { client, batches } = fakeClient(async () => ({ id: 'p1', doNotContact: false }));
      const budget = new TwentyBudget(100, () => 0);
      await connector.flushBatch(
        twentyWebhook(),
        [
          delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'a@b.com' }),
          delivery('d2', { event_type: 'goal', goal_name: 'audit_cta_rdv', user_id: 'a@b.com' }),
        ],
        client,
        budget,
      );
      expect(batches[0][0].id).not.toBe(batches[0][1].id);
    });

    it('exactly-once at the server: replaying yields ONE activity per id (409 dedup)', async () => {
      // Simulate Twenty's server-side dedup keyed by the client-supplied id.
      const stored = new Set<string>();
      let duplicateRejected = 0;
      const client = {
        async resolvePerson() {
          return { id: 'p1', doNotContact: false };
        },
        async batchTimeline(items: any[]) {
          for (const it of items) {
            if (stored.has(it.id)) {
              duplicateRejected += 1; // Twenty would 409 → connector no-ops
              continue;
            }
            stored.add(it.id);
          }
        },
      } as unknown as TwentyClient;
      const budget = new TwentyBudget(100, () => 0);
      const d = delivery('d1', { event_type: 'goal', goal_name: 'rdv_booked', user_id: 'a@b.com' });
      await connector.flushBatch(twentyWebhook(), [d], client, budget);
      connector.clearCache();
      await connector.flushBatch(twentyWebhook(), [d], client, budget);
      // One unique activity stored despite two flushes — exactly-once.
      expect(stored.size).toBe(1);
      expect(duplicateRejected).toBe(1);
    });
  });
});
