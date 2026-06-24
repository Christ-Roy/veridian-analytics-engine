// Set env vars BEFORE any imports so ConfigModule picks them up.
import { setupTestEnv } from './constants/test-config';
setupTestEnv();
process.env.WEBHOOK_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.WEBHOOK_ALLOW_HTTP = 'true'; // mock target is on 127.0.0.1
process.env.WEBHOOK_ALLOW_PRIVATE_IPS = 'true'; // ditto — relaxes the SSRF guard for tests

import { ConfigService } from '@nestjs/config';
import {
  createTestApp,
  closeTestApp,
  TestAppContext,
} from './helpers/app.helper';
import { createUserWithToken, createMembership } from './helpers/user.helper';
import { createTestWorkspace } from './helpers/workspace.helper';
import {
  startMockWebhookTarget,
  MockWebhookTarget,
} from './utils/mock-webhook-target';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { WebhookDeliveryWorker } from '../src/webhooks/webhook-delivery-worker.service';
import { WebhookTransformEngine } from '../src/webhooks/webhook-transform-engine';
import { SsrfGuard } from '../src/common/ssrf-guard';
import { TwentyConnectorService } from '../src/webhooks/connectors/twenty-connector.service';
import { WebhookDefinition } from '../src/webhooks/entities/webhook-definition.entity';

const WS = 'test_ws_webhook_leader';

/**
 * Real-ClickHouse proof of the single-leader gate (no mocks of the queue).
 *
 * The whole point of the fix: `findReadyDeliveries` has no atomic claim, so
 * correctness depends on EXACTLY ONE process draining the queue. We assert that
 * against the real `webhook_deliveries` table and a real HTTP target:
 *   - a leader=false worker NEVER POSTs (row stays pending),
 *   - a leader=true worker drains exactly once,
 *   - the SABOTAGE: one leader + one non-leader racing the SAME real row →
 *     exactly ONE POST reaches the target (the non-leader is muted by design).
 *
 * We build the workers by hand (real collaborators pulled from the live module)
 * so we control each one's WEBHOOK_WORKER_LEADER without restarting the app.
 */
describe('Webhook delivery worker — single-leader gate (real ClickHouse)', () => {
  let ctx: TestAppContext;
  let mock: MockWebhookTarget;
  let webhooks: WebhooksService;
  let transformEngine: WebhookTransformEngine;
  let ssrf: SsrfGuard;
  let twenty: TwentyConnectorService;

  /** Build a fresh worker bound to the live services, with a chosen leader flag. */
  function makeWorker(leaderEnv: string | undefined): WebhookDeliveryWorker {
    const cfg = {
      get: (k: string) => {
        if (k === 'WEBHOOK_WORKER_LEADER') return leaderEnv;
        if (k === 'WEBHOOK_ALLOW_HTTP') return 'true';
        if (k === 'WEBHOOK_ALLOW_PRIVATE_IPS') return 'true';
        return undefined;
      },
    } as unknown as ConfigService;
    const w = new WebhookDeliveryWorker(webhooks, transformEngine, ssrf, cfg, twenty);
    w.onModuleInit();
    return w;
  }

  async function createGenericWebhook(name: string): Promise<WebhookDefinition> {
    const pub = await webhooks.create({
      workspace_id: WS,
      name,
      url: `${mock.url}/leader-gate`,
      events: ['screen_view'],
      auth: { type: 'none' },
      transform: { type: 'passthrough' },
    });
    // Re-read the full definition (with secret) the worker would resolve.
    const def = await webhooks.findByIdInternal(pub.id);
    if (!def) throw new Error('webhook not found after create');
    return def;
  }

  async function deliveryStatus(id: string): Promise<string | null> {
    const result = await ctx.systemClient.query({
      query:
        'SELECT status FROM webhook_deliveries FINAL WHERE workspace_id = {ws:String} AND id = {id:String}',
      query_params: { ws: WS, id },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ status: string }>;
    return rows.length > 0 ? rows[0].status : null;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    mock = await startMockWebhookTarget();

    const { id: userId } = await createUserWithToken(
      ctx.app,
      ctx.systemClient,
      'webhook-leader-test@test.com',
      undefined,
      { name: 'Leader Gate Test', isSuperAdmin: true },
    );
    await createTestWorkspace(ctx.systemClient, WS);
    await createMembership(ctx.systemClient, WS, userId, 'owner');

    webhooks = ctx.moduleFixture.get<WebhooksService>(WebhooksService);
    transformEngine = ctx.moduleFixture.get<WebhookTransformEngine>(WebhookTransformEngine);
    ssrf = ctx.moduleFixture.get<SsrfGuard>(SsrfGuard);
    twenty = ctx.moduleFixture.get<TwentyConnectorService>(TwentyConnectorService);
  }, 60_000);

  afterAll(async () => {
    await mock.close();
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.systemClient.command({ query: 'TRUNCATE TABLE webhook_definitions' });
    await ctx.systemClient.command({ query: 'TRUNCATE TABLE webhook_deliveries' });
    mock.reset();
  });

  it('leader=false worker does NOT POST — the pending row stays untouched', async () => {
    const webhook = await createGenericWebhook('non-leader-hook');
    const delivery = await webhooks.enqueueDelivery(webhook, {
      event_id: 'evt_nl',
      event_type: 'screen_view',
      payload: { event_type: 'screen_view', path: '/x' },
    });

    const nonLeader = makeWorker('false');
    await nonLeader.tick();

    expect(mock.requests.length).toBe(0); // never POSTed
    expect(await deliveryStatus(delivery.id)).toBe('pending'); // still queued
  }, 30_000);

  it('leader=true worker drains the real row exactly once', async () => {
    const webhook = await createGenericWebhook('leader-hook');
    const delivery = await webhooks.enqueueDelivery(webhook, {
      event_id: 'evt_l',
      event_type: 'screen_view',
      payload: { event_type: 'screen_view', path: '/y' },
    });

    const leader = makeWorker('true');
    await leader.tick();

    expect(mock.requests.length).toBe(1); // delivered once
    expect(await deliveryStatus(delivery.id)).toBe('success');
  }, 30_000);

  it('SABOTAGE: leader + non-leader racing the SAME real row → exactly ONE POST', async () => {
    const webhook = await createGenericWebhook('race-hook');
    await webhooks.enqueueDelivery(webhook, {
      event_id: 'evt_race',
      event_type: 'screen_view',
      payload: { event_type: 'screen_view', path: '/race' },
    });

    const leader = makeWorker('true');
    const nonLeader = makeWorker('false');

    // Both tick concurrently against the shared real queue. Without the gate
    // both would read the same pending row and double-POST; with it, only the
    // leader drains.
    await Promise.all([leader.tick(), nonLeader.tick()]);

    expect(mock.requests.length).toBe(1); // single delivery despite two workers
  }, 30_000);
});
