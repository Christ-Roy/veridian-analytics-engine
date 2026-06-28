// Set env vars BEFORE any imports so ConfigModule picks them up.
import {
  setupTestEnv,
  PLATFORM_ADMIN_API_KEY as PLATFORM_KEY,
} from './constants/test-config';
setupTestEnv();

import request from 'supertest';
import { ClickHouseClient } from '@clickhouse/client';
import {
  toClickHouseDateTime,
  createTestWorkspace,
  truncateSystemTables,
  truncateWorkspaceTables,
  createTestApp,
  closeTestApp,
  TestAppContext,
} from './helpers';
import { waitForMutations } from './helpers/wait.helper';

/**
 * E2E for the VAGUE 2 custom dashboard widgets ("comme Twenty") against a REAL
 * ClickHouse (mock-cache-le-bug). Proves:
 *  - setLayout persists a valid widget {dimension_table, sessions, channel_group}
 *  - analytics.widgetData compiles it and returns the EXACT group-by from CH data
 *  - the 8 native widgets still work (non-regression: order/hide round-trips)
 *  - the 4 mandated sabotage cases are 400 at setLayout (never persisted)
 *  - widgetData on an unknown id is a 404
 *  - a request CANNOT smuggle a metric/dimension (config is authority)
 */
const TEST_WS = 'widget_config_test_ws';

describe('Custom dashboard widgets E2E (VAGUE 2)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;

  const url = '/api/admin/platform';
  const auth = () => ['Authorization', `Bearer ${PLATFORM_KEY}`] as const;

  // Known seeded distribution of sessions by channel_group (see seed below).
  // 30 sessions: i%3==0 -> 'search-paid' (10), i%3==1 -> 'social-organic' (10),
  // else -> 'direct' (10). device: i%2==0 desktop (15) / mobile (15).
  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: TEST_WS });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await truncateWorkspaceTables(
      workspaceClient,
      ['sessions', 'pages', 'goals'],
      0,
    );

    await createTestWorkspace(systemClient, TEST_WS, {
      name: 'Widget Config Co',
      website: 'https://widget.test',
      timezone: 'UTC',
    });
    await waitForMutations(systemClient, 'workspaces');

    // Seed 30 sessions in the recent window so `previous_30_days` covers them.
    const base = new Date();
    base.setDate(base.getDate() - 5);
    const sessions = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(base);
      d.setHours(d.getHours() + i);
      sessions.push({
        id: `wc-session-${i}`,
        workspace_id: TEST_WS,
        created_at: toClickHouseDateTime(d),
        updated_at: toClickHouseDateTime(d),
        visitor_id: `visitor-${i % 12}`,
        duration: 30 + i,
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        day_of_week: d.getDay() || 7,
        week_number: 1,
        hour: d.getHours(),
        is_weekend: false,
        is_direct: i % 3 === 2,
        landing_page: 'https://widget.test/',
        landing_path: '/',
        channel_group:
          i % 3 === 0
            ? 'search-paid'
            : i % 3 === 1
              ? 'social-organic'
              : 'direct',
        channel: i % 3 === 0 ? 'Paid Search' : i % 3 === 1 ? 'Social' : 'Direct',
        device: i % 2 === 0 ? 'desktop' : 'mobile',
        browser: 'Chrome',
        os: 'macOS',
        max_scroll: 50 + i,
        pageview_count: 1 + (i % 3),
        sdk_version: '1.0.0',
      });
    }
    await workspaceClient.insert({
      table: 'sessions',
      values: sessions,
      format: 'JSONEachRow',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE sessions FINAL' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const setLayout = (dashboard_layout: Record<string, unknown>) =>
    request(ctx.app.getHttpServer())
      .post(`${url}/workspaces.setLayout`)
      .set(...auth())
      .send({ workspace_id: TEST_WS, dashboard_layout });

  const widgetData = (widget_id: string, extra: Record<string, unknown> = {}) =>
    request(ctx.app.getHttpServer())
      .post(`${url}/analytics.widgetData`)
      .set(...auth())
      .send({
        workspace_id: TEST_WS,
        widget_id,
        dateRange: { preset: 'previous_30_days' },
        ...extra,
      });

  // ── PREUVE PRINCIPALE — dimension_table group-by réel ───────────────────
  it('persists a dimension_table widget and widgetData returns the real channel_group group-by', async () => {
    const res = await setLayout({
      widgets: [
        {
          id: 'canaux',
          kind: 'dimension_table',
          title: 'Sessions par canal',
          metric: 'sessions',
          table: 'sessions',
          dimension: 'channel_group',
          limit: 10,
        },
      ],
      order: ['canaux', 'pages'], // custom id + native key
    }).expect(200);
    expect(res.body.dashboard_layout.widgets).toHaveLength(1);

    await waitForMutations(systemClient, 'workspaces');

    const data = await widgetData('canaux').expect(200);
    expect(data.body).toMatchObject({
      widget_id: 'canaux',
      kind: 'dimension_table',
      title: 'Sessions par canal',
    });
    expect(Array.isArray(data.body.data)).toBe(true);

    const byChannel: Record<string, number> = {};
    for (const row of data.body.data as Array<Record<string, unknown>>) {
      byChannel[row.channel_group as string] = Number(row.sessions);
    }
    // Exact seeded distribution: 10 / 10 / 10.
    expect(byChannel['search-paid']).toBe(10);
    expect(byChannel['social-organic']).toBe(10);
    expect(byChannel['direct']).toBe(10);
  });

  it('metric_card widget returns a single total (no group-by)', async () => {
    await setLayout({
      widgets: [
        {
          id: 'total-visiteurs',
          kind: 'metric_card',
          title: 'Visiteurs uniques',
          metric: 'unique_visitors',
        },
      ],
      // Reset order to stay consistent with the replaced widget set (the merge
      // keeps a stale `order` otherwise — which would correctly 400).
      order: [],
    }).expect(200);
    await waitForMutations(systemClient, 'workspaces');

    const data = await widgetData('total-visiteurs').expect(200);
    expect(data.body.kind).toBe('metric_card');
    expect(Array.isArray(data.body.data)).toBe(true);
    expect(data.body.data).toHaveLength(1);
    // 12 distinct visitor_id seeded (i % 12).
    expect(Number((data.body.data[0] as Record<string, unknown>).unique_visitors)).toBe(12);
  });

  it('time_series widget buckets by its configured granularity', async () => {
    await setLayout({
      widgets: [
        {
          id: 'sessions-jour',
          kind: 'time_series',
          title: 'Sessions par jour',
          metric: 'sessions',
          granularity: 'day',
        },
      ],
      order: [],
    }).expect(200);
    await waitForMutations(systemClient, 'workspaces');

    const data = await widgetData('sessions-jour').expect(200);
    expect(data.body.kind).toBe('time_series');
    const rows = data.body.data as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    // Each row is a day bucket carrying the granularity column + the metric.
    expect(rows[0]).toHaveProperty('date_day');
    expect(rows[0]).toHaveProperty('sessions');
    // Sum of per-day sessions equals the 30 seeded.
    const total = rows.reduce((a, r) => a + Number(r.sessions ?? 0), 0);
    expect(total).toBe(30);
  });

  it('widget filters narrow the underlying query (device=desktop → 15)', async () => {
    await setLayout({
      widgets: [
        {
          id: 'desktop-canaux',
          kind: 'dimension_table',
          title: 'Canaux desktop',
          metric: 'sessions',
          dimension: 'channel_group',
          filters: [{ dimension: 'device', operator: 'equals', values: ['desktop'] }],
        },
      ],
      order: [],
    }).expect(200);
    await waitForMutations(systemClient, 'workspaces');

    const data = await widgetData('desktop-canaux').expect(200);
    const total = (data.body.data as Array<Record<string, unknown>>).reduce(
      (a, r) => a + Number(r.sessions ?? 0),
      0,
    );
    expect(total).toBe(15); // 15 desktop sessions across all channels
  });

  // ── NON-RÉGRESSION — natifs intouchés ───────────────────────────────────
  it('native widget order/hide still round-trips (8 natives untouched)', async () => {
    const res = await setLayout({
      order: ['goals', 'pages', 'sources'],
      hidden_widgets: ['devices', 'heatmap'],
      widgets: [], // clear customs to prove natives stand alone
    }).expect(200);
    expect(res.body.dashboard_layout.order).toEqual(['goals', 'pages', 'sources']);
    expect(res.body.dashboard_layout.hidden_widgets).toEqual(['devices', 'heatmap']);
  });

  it('hidden_widgets rejects an unknown native key (strict, unchanged)', async () => {
    await setLayout({ hidden_widgets: ['not_a_native_widget'] }).expect(400);
  });

  // ── SABOTAGE — les 4 cas du garde-fou 1 (400 au setLayout) ──────────────
  it('SABOTAGE metric inconnu → 400, never persisted', async () => {
    await setLayout({
      widgets: [
        { id: 'bad-metric', kind: 'metric_card', title: 'X', metric: 'not_a_metric' },
      ],
    }).expect(400);
  });

  it('SABOTAGE dimension sur metric_card → 400', async () => {
    await setLayout({
      widgets: [
        {
          id: 'bad-card',
          kind: 'metric_card',
          title: 'X',
          metric: 'sessions',
          dimension: 'channel_group',
        },
      ],
    }).expect(400);
  });

  it('SABOTAGE time_series sans granularity → 400', async () => {
    await setLayout({
      widgets: [
        { id: 'bad-ts', kind: 'time_series', title: 'X', metric: 'sessions' },
      ],
    }).expect(400);
  });

  it('SABOTAGE id dupliqué → 400', async () => {
    await setLayout({
      widgets: [
        { id: 'dup', kind: 'metric_card', title: 'A', metric: 'sessions' },
        { id: 'dup', kind: 'metric_card', title: 'B', metric: 'pageviews' },
      ],
    }).expect(400);
  });

  it('SABOTAGE excluded identifier dimension (user_id) → 400', async () => {
    await setLayout({
      widgets: [
        {
          id: 'leak',
          kind: 'dimension_table',
          title: 'X',
          metric: 'sessions',
          dimension: 'user_id',
        },
      ],
    }).expect(400);
  });

  it('SABOTAGE order references an undefined widget id → 400', async () => {
    await setLayout({
      widgets: [{ id: 'real', kind: 'metric_card', title: 'X', metric: 'sessions' }],
      order: ['real', 'ghost-widget'],
    }).expect(400);
  });

  // ── ROOT-CAUSE: "Pages les plus consultées" cross-table breakage ────────
  // The original bug: a {table:'pages', metric:'pageviews'} widget was persisted
  // (pageviews IS in the widget whitelist, just not as a `pages` metric) and then
  // exploded at widgetData with the runtime 400 "Metric pageviews is not
  // available for table pages". The persist gate now crosses metric×table against
  // the AUTHORITATIVE METRICS constants → rejected at setLayout, never stored.
  it("SABOTAGE THE BUG — {table:'pages', metric:'pageviews'} → 400 INVALID_WIDGET_CONFIG, never persisted", async () => {
    const res = await setLayout({
      widgets: [
        {
          id: 'pages-vues',
          kind: 'dimension_table',
          title: 'Pages les plus consultées',
          metric: 'pageviews',
          table: 'pages',
          dimension: 'page_path',
        },
      ],
    }).expect(400);
    expect(res.body.code).toBe('INVALID_WIDGET_CONFIG');
    // The incoherent widget must NOT have been persisted → widgetData 404.
    await waitForMutations(systemClient, 'workspaces');
    const probe = await widgetData('pages-vues');
    expect(probe.status).toBe(404);
  });

  it("THE FIX — {table:'pages', metric:'page_count', dimension:'page_path'} persists and resolves", async () => {
    await setLayout({
      widgets: [
        {
          id: 'top-pages',
          kind: 'dimension_table',
          title: 'Pages les plus consultées',
          metric: 'page_count',
          table: 'pages',
          dimension: 'page_path',
          limit: 20,
        },
      ],
    }).expect(200);
    await waitForMutations(systemClient, 'workspaces');
    // widgetData compiles the pages group-by and returns real ClickHouse data —
    // no runtime 400, because the persist gate guarantees metric/table coherence.
    const data = await widgetData('top-pages').expect(200);
    expect(data.body.widget_id).toBe('top-pages');
    expect(Array.isArray(data.body.data)).toBe(true);
  });

  it('SABOTAGE dimension off-table → 400 (page_path filter/dimension on sessions)', async () => {
    await setLayout({
      widgets: [
        {
          id: 'bad-dim',
          kind: 'dimension_table',
          title: 'X',
          metric: 'sessions',
          table: 'sessions',
          dimension: 'page_path',
        },
      ],
    }).expect(400);
  });

  // ── widgetData edge cases ───────────────────────────────────────────────
  it('widgetData on an unknown widget id → 404 WIDGET_NOT_FOUND', async () => {
    // Persist a known-good widget first so the layout exists.
    await setLayout({
      widgets: [{ id: 'exists', kind: 'metric_card', title: 'X', metric: 'sessions' }],
    }).expect(200);
    await waitForMutations(systemClient, 'workspaces');

    const res = await widgetData('does-not-exist').expect(404);
    expect(res.body.code).toBe('WIDGET_NOT_FOUND');
  });

  it('widgetData ignores any metric/dimension smuggled in the request body', async () => {
    await setLayout({
      widgets: [
        {
          id: 'authoritative',
          kind: 'dimension_table',
          title: 'Canaux',
          metric: 'sessions',
          dimension: 'channel_group',
        },
      ],
    }).expect(200);
    await waitForMutations(systemClient, 'workspaces');

    // Attempt to override metric/dimension via the request — must be ignored
    // (ValidationPipe whitelist strips them; even if present, the service reads
    // the stored config). Response stays the channel_group group-by.
    const data = await widgetData('authoritative', {
      metric: 'user_id',
      dimension: 'user_id',
    } as Record<string, unknown>).expect(200);
    const rows = data.body.data as Array<Record<string, unknown>>;
    expect(rows.every((r) => 'channel_group' in r)).toBe(true);
    expect(rows.some((r) => 'user_id' in r)).toBe(false);
  });
});
