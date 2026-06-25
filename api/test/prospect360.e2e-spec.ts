// Set env vars BEFORE any imports so ConfigModule picks them up.
import {
  setupTestEnv,
  PLATFORM_ADMIN_API_KEY as PLATFORM_KEY,
} from './constants/test-config';
setupTestEnv();

import request from 'supertest';
import { ClickHouseClient } from '@clickhouse/client';
import { EventBufferService } from '../src/events/event-buffer.service';
import {
  createTestWorkspace,
  truncateSystemTables,
  truncateWorkspaceTables,
  createTestApp,
  closeTestApp,
  getService,
  waitForClickHouse,
  waitForRowCount,
  TestAppContext,
} from './helpers';

const WS = 'prospect360_test_ws';
const WS_DB = `staminads_ws_${WS}`;

/**
 * PROSPECT 360 — e2e against a REAL ClickHouse (no mocks). Proves that, with the
 * PLATFORM key alone, analytics.prospect360 composes the 4 blocks in one call:
 *   • provenance      (from a seeded user_attribution row)
 *   • account.created (true because the user is identified)
 *   • journey         (chronological events ingested through the REAL /api/track)
 *   • ads_conversions (a gclid-attributed goal, filtered to this user)
 *
 * Sabotage: an unknown user → found:false, empty blocks, HTTP 200 (never a 500).
 *
 * The journey block is THE trou this ticket fixes: export.userEvents was gated by
 * the WORKSPACE key (stam_live_*); here we read it with the PLATFORM key.
 *
 * Auth: setupTestEnv() exports PLATFORM_ADMIN_API_KEY=PLATFORM_KEY into
 * process.env BEFORE any import, and the real PlatformAdminGuard reads
 * process.env (freshest source) — so the genuine guard accepts our Bearer key
 * with NO override needed.
 */
describe('Admin Platform — POST /api/admin/platform/analytics.prospect360 (M2M)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let eventBuffer: EventBufferService;

  const auth = (req: request.Test) =>
    req.set('Authorization', `Bearer ${PLATFORM_KEY}`);

  beforeAll(async () => {
    // We override the guard at the AppModule level; createTestApp builds the app
    // for us but uses the REAL guard. The real PlatformAdminGuard reads
    // PLATFORM_ADMIN_API_KEY from env (setupTestEnv exported it), so the same
    // PLATFORM_KEY is accepted. No guard override needed when env is set.
    ctx = await createTestApp({ workspaceId: WS, mockMailService: true });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;
    eventBuffer = getService(ctx, EventBufferService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncateSystemTables(systemClient, ['workspaces']);
    await truncateWorkspaceTables(workspaceClient, [
      'events',
      'sessions',
      'pages',
      'goals',
      'user_attribution',
    ]);
    await createTestWorkspace(systemClient, WS, { status: 'active' });
  });

  const post = (body: unknown) =>
    auth(
      request(ctx.app.getHttpServer()).post(
        '/api/admin/platform/analytics.prospect360',
      ),
    ).send(body);

  it('returns 401 without a Bearer token', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/analytics.prospect360')
      .send({ workspace_id: WS, user: 'x@y.z' })
      .expect(401);
  });

  it('returns 400 when user is missing (per-prospect fiche requires a user)', async () => {
    await post({ workspace_id: WS }).expect(400);
  });

  it('returns 404 for an unknown workspace', async () => {
    await post({ workspace_id: 'no_such_ws_xyz', user: 'x@y.z' }).expect(404);
  });

  it('SABOTAGE: unknown user → 200 with found:false + empty blocks (never 500)', async () => {
    const res = await post({ workspace_id: WS, user: 'ghost@nobody.test' }).expect(
      200,
    );
    expect(res.body).toMatchObject({
      workspace_id: WS,
      user: 'ghost@nobody.test',
      found: false,
      provenance: null,
      journey: [],
      ads_conversions: [],
    });
    expect(res.body.account).toMatchObject({ created: false, user_id: null });
    expect(res.body.journey_window_days).toBe(7);
    expect(res.body.journey_truncated).toBe(false);
  });

  it('composes the full 360 fiche in ONE platform-key call', async () => {
    const user = `prospect_${Date.now()}@client.fr`;
    const seoSession = `sess-seo-${Date.now()}`;
    const adsSession = `sess-ads-${Date.now()}`;

    // 1) Journey: an identified SEO visit (2 pageviews + a signup goal).
    await request(ctx.app.getHttpServer())
      .post('/api/track')
      .send({
        workspace_id: WS,
        session_id: seoSession,
        user_id: user,
        created_at: Date.now() - 20000,
        updated_at: Date.now() - 10000,
        attributes: { landing_page: 'https://client.fr/blog' },
        actions: [
          {
            type: 'pageview',
            path: '/blog',
            page_number: 1,
            duration: 8000,
            scroll: 70,
            entered_at: Date.now() - 20000,
            exited_at: Date.now() - 15000,
          },
          {
            type: 'pageview',
            path: '/pricing',
            page_number: 2,
            duration: 12000,
            scroll: 90,
            entered_at: Date.now() - 15000,
            exited_at: Date.now() - 11000,
          },
          {
            type: 'goal',
            name: 'signup',
            path: '/register',
            page_number: 2,
            timestamp: Date.now() - 11000,
            value: 0,
          },
        ],
      })
      .expect(200);

    // 2) Ads conversion: a later visit carrying a gclid + a form_submission goal
    //    with a value. This is what ads.conversions reads (utm_id_from=gclid).
    await request(ctx.app.getHttpServer())
      .post('/api/track')
      .send({
        workspace_id: WS,
        session_id: adsSession,
        user_id: user,
        created_at: Date.now() - 5000,
        updated_at: Date.now() - 1000,
        attributes: {
          landing_page: 'https://client.fr/lp?gclid=GCLID_PROSPECT360',
          utm_id: 'GCLID_PROSPECT360',
          utm_id_from: 'gclid',
        },
        actions: [
          {
            type: 'pageview',
            path: '/lp',
            page_number: 1,
            duration: 4000,
            scroll: 50,
            entered_at: Date.now() - 5000,
            exited_at: Date.now() - 2000,
          },
          {
            type: 'goal',
            name: 'form_submission',
            path: '/lp',
            page_number: 1,
            timestamp: Date.now() - 1500,
            value: 250,
          },
        ],
      })
      .expect(200);

    await eventBuffer.flushAll();
    await waitForClickHouse();
    // 3 events from seoSession (2 pageview + 1 goal) + 2 from adsSession.
    await waitForRowCount(
      workspaceClient,
      `SELECT count() as count FROM ${WS_DB}.events WHERE user_id = '${user}'`,
      5,
    );

    // 3) Provenance: seed the canonical user_attribution row (what the stitch /
    //    identity backfill writes). prospect360 reuses userProvenance to read it.
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
    await workspaceClient.insert({
      table: `${WS_DB}.user_attribution`,
      values: [
        {
          identity_key: user,
          user_id: user,
          first_touch_channel: 'organic_search',
          first_touch_channel_group: 'seo',
          first_touch_landing_page: 'https://client.fr/blog',
          first_touch_at: now,
          first_touch_method: 'fingerprint',
          last_touch_channel: 'paid_search',
          last_touch_channel_group: 'ads',
          last_touch_at: now,
          referral_code: '',
          first_seen_at: now,
          updated_at: now,
        },
      ],
      format: 'JSONEachRow',
    });
    await workspaceClient.command({
      query: `OPTIMIZE TABLE ${WS_DB}.user_attribution FINAL`,
    });
    await waitForClickHouse();

    // ── The single M2M call (platform key only) ──────────────────────────────
    const res = await post({ workspace_id: WS, user }).expect(200);
    const body = res.body;

    // found + identity
    expect(body.found).toBe(true);
    expect(body.user).toBe(user);
    expect(body.account).toMatchObject({ created: true, user_id: user });
    expect(body.account.first_seen_at).toBeTruthy();

    // Block 1 — provenance (the stitched first-touch)
    expect(body.provenance).toMatchObject({
      user_id: user,
      first_touch_channel_group: 'seo',
      first_touch_channel: 'organic_search',
    });

    // Block 3 — journey: all 5 events, chronological (oldest→newest)
    expect(body.journey_window_days).toBe(7);
    expect(Array.isArray(body.journey)).toBe(true);
    expect(body.journey.length).toBe(5);
    const paths = body.journey.map((s: { path: string }) => s.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/blog', '/pricing', '/register', '/lp']),
    );
    // chronology: timestamps must be non-decreasing
    const times = body.journey.map((s: { at: string }) => s.at);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
    // the signup goal is present as a goal step
    const signup = body.journey.find(
      (s: { goal_name: string | null }) => s.goal_name === 'signup',
    );
    expect(signup).toMatchObject({ type: 'goal', goal_name: 'signup' });

    // Block 4 — ads_conversions: the gclid form_submission of THIS user only
    expect(Array.isArray(body.ads_conversions)).toBe(true);
    expect(body.ads_conversions.length).toBe(1);
    expect(body.ads_conversions[0]).toMatchObject({
      click_id_source: 'gclid',
      click_id: 'GCLID_PROSPECT360',
      conversion_type: 'form_submission',
      value: 250,
      user_id: user,
    });
  });

  it('found:true with empty provenance when journey exists but user not yet stitched', async () => {
    // A user with events but NO user_attribution row (anonymous → identified mid
    // session, stitch not run yet). prospect360 must still surface the journey
    // and report account.created=false (no canonical row), found=true.
    const user = `unstitched_${Date.now()}@client.fr`;
    await request(ctx.app.getHttpServer())
      .post('/api/track')
      .send({
        workspace_id: WS,
        session_id: `sess-uns-${Date.now()}`,
        user_id: user,
        created_at: Date.now() - 8000,
        updated_at: Date.now() - 2000,
        attributes: { landing_page: 'https://client.fr/' },
        actions: [
          {
            type: 'pageview',
            path: '/',
            page_number: 1,
            duration: 3000,
            scroll: 40,
            entered_at: Date.now() - 8000,
            exited_at: Date.now() - 5000,
          },
        ],
      })
      .expect(200);

    await eventBuffer.flushAll();
    await waitForClickHouse();
    await waitForRowCount(
      workspaceClient,
      `SELECT count() as count FROM ${WS_DB}.events WHERE user_id = '${user}'`,
      1,
    );

    const res = await post({ workspace_id: WS, user }).expect(200);
    expect(res.body.found).toBe(true);
    expect(res.body.provenance).toBeNull();
    expect(res.body.account.created).toBe(false);
    expect(res.body.account.user_id).toBe(user);
    expect(res.body.journey.length).toBe(1);
    expect(res.body.ads_conversions).toEqual([]);
  });
});
