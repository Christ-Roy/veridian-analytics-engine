// Set env vars BEFORE any imports to ensure ConfigModule picks them up
import { setupTestEnv } from './constants/test-config';
setupTestEnv();

import { ClickHouseClient } from '@clickhouse/client';
import {
  toClickHouseDateTime,
  createTestWorkspace,
  truncateSystemTables,
  truncateWorkspaceTables,
  createTestApp,
  closeTestApp,
  waitForClickHouse,
  waitForMutations,
  TestAppContext,
} from './helpers';
import { IdentityStitchService } from '../src/events/identity-stitch.service';
import { TwentyConnectorService } from '../src/webhooks/connectors/twenty-connector.service';
import { TwentyBudget } from '../src/webhooks/connectors/twenty-budget';
import { TwentyClient } from '../src/webhooks/connectors/twenty-client';
import {
  WebhookDefinition,
  DEFAULT_RETRY_CONFIG,
} from '../src/webhooks/entities/webhook-definition.entity';
import { WebhookDelivery } from '../src/webhooks/entities/webhook-delivery.entity';

const testWorkspaceId = 'twenty_acq_stitch_ws';

/**
 * S6 Lot TWENTY — "le CRM de l'analytics" (real ClickHouse E2E).
 *
 * Proves the END-TO-END truth that mocks cannot (cf
 * feedback_mock_cache_le_bug_tester_clickhouse_reel): the Twenty connector
 * reads the user's REAL stitched first-touch from the REAL `user_attribution`
 * table (written by the REAL IdentityStitchService) and surfaces it as the
 * acquisition on BOTH the timeline AND the Person field — instead of the
 * /login channel (= direct), which is what S4 alone would emit for a signup.
 *
 * Scenario (the proven-in-prod Yoga Sculpt case): an anonymous vitrine visit
 * via Google Ads (channel_group=ads) + a later /login session (direct), linked
 * by a shared fingerprint. After the stitch, a `signup` goal for that user must
 * carry `acquisitionSource='google_ads'` (timeline) and trigger a Person patch
 * with `firstTouchChannel='google_ads'`.
 *
 * The Twenty REST API itself is faked HERE (resolution + patch recorded), the
 * real PATCH /rest/people/:id round-trip was proven separately against the
 * REPLAY test workspace via REST+Bearer (acquisition fields persisted &
 * filterable, score untouched).
 */
describe('Twenty connector — stitched acquisition (E2E real ClickHouse)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let stitch: IdentityStitchService;
  let connector: TwentyConnectorService;
  const workspaceId = testWorkspaceId;
  const dbName = `staminads_ws_${workspaceId}`;
  const baseDate = new Date('2026-06-25T10:00:00.000Z');

  function sessionRow(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    return {
      id: 'acq-sess-default',
      workspace_id: workspaceId,
      created_at: toClickHouseDateTime(d),
      updated_at: toClickHouseDateTime(d),
      is_direct: true,
      landing_page: 'https://app.test.com/login',
      landing_domain: 'app.test.com',
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      day_of_week: d.getUTCDay() || 7,
      week_number: 1,
      hour: d.getUTCHours(),
      is_weekend: false,
      channel: '',
      channel_group: '',
      first_touch_channel: '',
      first_touch_channel_group: '',
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      utm_content: '',
      utm_id: '',
      utm_id_from: '',
      referrer: '',
      referrer_domain: '',
      user_id: null,
      visitor_id: '',
      fingerprint: '',
      ip: '',
      ...overrides,
    };
  }

  /**
   * Seed an anonymous Google-Ads vitrine session + an identified /login session
   * linked by a shared fingerprint, then run the REAL stitch so a real
   * `user_attribution` row exists for `email` with first_touch_channel_group=ads.
   */
  async function seedAndStitch(email: string): Promise<void> {
    await truncateWorkspaceTables(workspaceClient, ['sessions'], 0);
    const fp = 'fp_acq_shared';
    const vitrineTime = new Date(baseDate);
    const appTime = new Date(baseDate);
    appTime.setUTCMinutes(appTime.getUTCMinutes() + 1);

    const vitrine = sessionRow({
      id: 'acq-vitrine',
      created_at: toClickHouseDateTime(vitrineTime),
      updated_at: toClickHouseDateTime(vitrineTime),
      landing_page: 'https://test.com/?gclid=abc',
      landing_domain: 'test.com',
      is_direct: false,
      channel: 'paid_search',
      channel_group: 'ads',
      user_id: null,
      visitor_id: 'vitrine-vid',
      fingerprint: fp,
    });
    const app = sessionRow({
      id: 'acq-app-login',
      created_at: toClickHouseDateTime(appTime),
      updated_at: toClickHouseDateTime(appTime),
      channel: 'direct',
      channel_group: 'direct',
      user_id: email,
      visitor_id: 'app-vid',
      fingerprint: fp,
    });
    await workspaceClient.insert({
      table: 'sessions',
      values: [vitrine, app],
      format: 'JSONEachRow',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE sessions FINAL' });
    await waitForClickHouse();

    const method = await stitch.stitch(workspaceId, email);
    expect(method).toBe('fingerprint');
    await waitForMutations(workspaceClient, dbName, {
      timeoutMs: 60000,
      intervalMs: 500,
      onTimeout: 'throw',
    });
    await waitForClickHouse();
  }

  /** A fake Twenty client that records resolution + acquisition patches. */
  function fakeClient(): {
    client: TwentyClient;
    batches: any[][];
    patches: Array<{ personId: string; fields: Record<string, string> }>;
  } {
    const batches: any[][] = [];
    const patches: Array<{ personId: string; fields: Record<string, string> }> =
      [];
    const client = {
      async resolvePerson() {
        return { id: 'person_jo', doNotContact: false };
      },
      async batchTimeline(items: any[]) {
        batches.push(items);
      },
      async patchPersonAcquisition(
        personId: string,
        fields: Record<string, string>,
      ) {
        patches.push({ personId, fields });
        return true;
      },
    } as unknown as TwentyClient;
    return { client, batches, patches };
  }

  function twentyWebhook(): WebhookDefinition {
    return {
      id: 'wh_acq',
      workspace_id: workspaceId,
      name: 'twenty',
      url: 'https://crm.test.veridian.site',
      active: true,
      auth_type: 'bearer',
      auth_secret_encrypted: 'enc',
      events: ['goal'],
      filters: [],
      transform: { type: 'twenty' },
      retry_config: DEFAULT_RETRY_CONFIG,
      created_at: '2026-06-25 10:00:00.000',
      updated_at: '2026-06-25 10:00:00.000',
      deleted_at: null,
    };
  }

  function signupDelivery(id: string, email: string): WebhookDelivery {
    // /login signup event: NO referrer / utm → S4 alone would emit `direct`.
    const payload = { event_type: 'goal', goal_name: 'signup', user_id: email };
    return {
      id,
      webhook_id: 'wh_acq',
      workspace_id: workspaceId,
      event_id: `evt_${id}`,
      event_type: 'goal',
      attempt: 1,
      scheduled_at: '2026-06-25 10:00:00.000',
      sent_at: null,
      status: 'pending',
      http_status: null,
      latency_ms: null,
      request_url: 'https://crm.test.veridian.site',
      request_body: JSON.stringify(payload),
      response_body: '',
      error_message: '',
      created_at: '2026-06-25 10:00:00.000',
      updated_at: '2026-06-25 10:00:00.000',
    };
  }

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;
    stitch = ctx.moduleFixture.get(IdentityStitchService);
    connector = ctx.moduleFixture.get(TwentyConnectorService);

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await createTestWorkspace(systemClient, workspaceId, {
      name: 'Twenty Acquisition Stitch Workspace',
      website: 'https://app.test.com',
    });
  });

  afterEach(() => {
    connector.clearCache();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('signup of a stitched user → timeline AND Person field carry google_ads (read from REAL user_attribution)', async () => {
    const email = 'jo@acq.test';
    await seedAndStitch(email);

    const { client, batches, patches } = fakeClient();
    const budget = new TwentyBudget(100, () => 0);
    const out = await connector.flushBatch(
      twentyWebhook(),
      [signupDelivery('d1', email)],
      client,
      budget,
    );

    expect(out.written).toEqual(['d1']);
    // Timeline milestone carries the STITCHED provenance, not the /login direct.
    expect(batches[0][0].name).toBe('signup');
    expect(batches[0][0].properties.acquisitionSource).toBe('google_ads');
    // Person field patched with the same vocabulary — acquisition ONLY.
    expect(patches).toEqual([
      { personId: 'person_jo', fields: { firstTouchChannel: 'google_ads' } },
    ]);
  });

  it('SABOTAGE: an un-stitched user → timeline stays direct + NO Person patch', async () => {
    const email = 'nobody@acq.test';
    // No seed/stitch for this user → user_attribution has no row.
    const { client, batches, patches } = fakeClient();
    const budget = new TwentyBudget(100, () => 0);
    await connector.flushBatch(
      twentyWebhook(),
      [signupDelivery('d2', email)],
      client,
      budget,
    );

    // Without a real stitched row, the connector genuinely falls back to S4 →
    // the /login event with no referrer is `direct`. Proves the google_ads above
    // came from the REAL stitch, not from a hard-coded value.
    expect(batches[0][0].properties.acquisitionSource).toBe('direct');
    expect(patches).toEqual([]);
  });
});
