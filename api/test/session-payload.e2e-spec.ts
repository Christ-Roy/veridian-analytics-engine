// Set env vars BEFORE any imports to ensure ConfigModule picks them up
import { setupTestEnv } from './constants/test-config';
setupTestEnv();

import { ClickHouseClient, createClient } from '@clickhouse/client';
import request from 'supertest';
import { EventBufferService } from '../src/events/event-buffer.service';
import {
  createTestWorkspace,
  createTestApiKey,
  truncateSystemTables,
  truncateWorkspaceTables,
  createTestApp,
  closeTestApp,
  getService,
  waitForClickHouse,
  waitForRowCount,
  getWorkspaceDatabaseName,
  TestAppContext,
} from './helpers';
import { getSystemClientConfig } from './constants/test-config';

const testWorkspaceId = 'test_ws_v3';

describe('V3 Session Payload E2E', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let eventBuffer: EventBufferService;
  let apiKey: string;

  const createSessionPayload = (overrides: Record<string, unknown> = {}) => ({
    workspace_id: testWorkspaceId,
    session_id: `sess-${Date.now()}`,
    actions: [],
    created_at: Date.now() - 10000,
    updated_at: Date.now(),
    ...overrides,
  });

  const createPageviewAction = (overrides: Record<string, unknown> = {}) => ({
    type: 'pageview',
    path: '/home',
    page_number: 1,
    duration: 5000,
    scroll: 50,
    entered_at: Date.now() - 5000,
    exited_at: Date.now(),
    ...overrides,
  });

  const createGoalAction = (overrides: Record<string, unknown> = {}) => ({
    type: 'goal',
    name: 'signup',
    path: '/register',
    page_number: 1,
    timestamp: Date.now(),
    ...overrides,
  });

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;
    eventBuffer = getService(ctx, EventBufferService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncateSystemTables(systemClient, ['workspaces', 'api_keys']);
    await truncateWorkspaceTables(workspaceClient, [
      'events',
      'sessions',
      'pages',
    ]);
    await createTestWorkspace(systemClient, testWorkspaceId);
    apiKey = await createTestApiKey(systemClient, testWorkspaceId);
  });

  describe('POST /api/track', () => {
    it('accepts valid session payload', async () => {
      const payload = createSessionPayload({
        actions: [createPageviewAction()],
        attributes: {
          landing_page: 'https://example.com/home',
          browser: 'Chrome',
        },
      });

      const response = await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('stores events in ClickHouse', async () => {
      const sessionId = `sess-store-${Date.now()}`;
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [
          createPageviewAction({ path: '/home', page_number: 1 }),
          createGoalAction({ name: 'signup', page_number: 1 }),
          createPageviewAction({ path: '/dashboard', page_number: 2 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      const result = await workspaceClient.query({
        query: `SELECT name, path, page_number, goal_name
                FROM events
                WHERE session_id = {session_id:String}
                ORDER BY page_number, name`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const events = await result.json();

      expect(events).toHaveLength(3);
      // Events are ordered by page_number, then name (goal < screen_view alphabetically)
      expect(events[0]).toMatchObject({ name: 'goal', goal_name: 'signup' });
      expect(events[1]).toMatchObject({ name: 'screen_view', path: '/home' });
      expect(events[2]).toMatchObject({
        name: 'screen_view',
        path: '/dashboard',
      });
    });

    it('stores visitor_id + fingerprint + server-captured IP (B2B), propagated to sessions', async () => {
      const sessionId = `sess-b2b-${Date.now()}`;
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [createPageviewAction({ path: '/home', page_number: 1 })],
        attributes: {
          landing_page: 'https://example.com/',
          fingerprint: 'fp_e2e_b2b',
        },
        visitor_id: 'visitor_e2e_b2b',
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        // A spoofed X-Forwarded-For MUST be ignored: without `trust proxy`
        // (test app), getClientIp falls back to the real TCP socket address.
        // This proves the IP is captured SERVER-SIDE and is non-spoofable.
        .set('X-Forwarded-For', '1.2.3.4')
        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      // events row carries all three B2B columns.
      const eventsRes = await workspaceClient.query({
        query: `SELECT visitor_id, fingerprint, ip
                FROM events WHERE session_id = {session_id:String} LIMIT 1`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const event = (
        await eventsRes.json<{
          visitor_id: string;
          fingerprint: string;
          ip: string;
        }>()
      )[0];
      expect(event?.visitor_id).toBe('visitor_e2e_b2b');
      expect(event?.fingerprint).toBe('fp_e2e_b2b');
      // IP is the real loopback socket address, NOT the spoofed XFF (1.2.3.4).
      expect(event?.ip).not.toBe('1.2.3.4');
      expect(event?.ip).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);

      // visitor_id fans out to the sessions table via sessions_mv.
      const sessRes = await workspaceClient.query({
        query: `SELECT visitor_id FROM sessions FINAL
                WHERE id = {session_id:String} LIMIT 1`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const session = (await sessRes.json<{ visitor_id: string }>())[0];
      expect(session?.visitor_id).toBe('visitor_e2e_b2b');
    });

    it('generates correct dedup_token for pageviews', async () => {
      const sessionId = 'sess-dedup-pv';
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [createPageviewAction({ page_number: 5 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      const result = await workspaceClient.query({
        query: `SELECT dedup_token FROM events WHERE session_id = {session_id:String}`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const [event] = await result.json();

      expect(event.dedup_token).toBe('sess-dedup-pv_pv_5');
    });

    it('generates correct dedup_token for goals', async () => {
      const sessionId = 'sess-dedup-goal';
      const timestamp = 1704067200000;
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [createGoalAction({ name: 'purchase', timestamp })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      const result = await workspaceClient.query({
        query: `SELECT dedup_token FROM events WHERE session_id = {session_id:String}`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const [event] = await result.json();

      expect(event.dedup_token).toBe(
        'sess-dedup-goal_goal_purchase_1704067200000',
      );
    });

    it('sets _version server timestamp', async () => {
      const sessionId = `sess-version-${Date.now()}`;
      const beforeTime = Date.now();

      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [createPageviewAction()],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      const afterTime = Date.now();
      await eventBuffer.flushAll();
      await waitForClickHouse();

      const result = await workspaceClient.query({
        query: `SELECT _version FROM events WHERE session_id = {session_id:String}`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const [event] = await result.json();

      expect(Number(event._version)).toBeGreaterThanOrEqual(beforeTime);
      expect(Number(event._version)).toBeLessThanOrEqual(afterTime);
    });

    it('rejects invalid workspace_id', async () => {
      const payload = createSessionPayload({
        workspace_id: 'invalid-ws',
        actions: [createPageviewAction()],
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        .expect(400);
    });

    it('validates nested actions', async () => {
      const payload = createSessionPayload({
        actions: [
          {
            type: 'pageview',
            // Missing required fields
          },
        ],
      });

      const response = await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('rejects unknown action type', async () => {
      const payload = createSessionPayload({
        actions: [
          {
            type: 'unknown_type',
            path: '/test',
          },
        ],
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(400);
    });
  });

  // Kill-switch d'ingestion par statut workspace (ticket
  // ingest-no-killswitch-workspace-inactif 2026-06-23).
  describe('POST /api/track — kill-switch workspace inactif', () => {
    const inactiveWsId = 'test_ws_inactive';

    it('drops ingestion silently (200, no events) for an inactive workspace', async () => {
      await createTestWorkspace(systemClient, inactiveWsId, {
        status: 'inactive',
      });

      const payload = createSessionPayload({
        workspace_id: inactiveWsId,
        session_id: `sess-killswitch-${Date.now()}`,
        actions: [createPageviewAction()],
        attributes: { landing_page: 'https://example.com/home' },
      });

      const response = await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        // 200 muet : on ne leak pas l'état du tenant à un client externe.
        .expect(200);

      expect(response.body.success).toBe(true);

      // Aucune écriture : le buffer ne doit rien avoir flushé.
      await eventBuffer.flushAll();
      const result = await workspaceClient.query({
        query: `SELECT count() AS c FROM events WHERE workspace_id = {ws:String}`,
        query_params: { ws: inactiveWsId },
        format: 'JSONEachRow',
      });
      const rows = (await result.json()) as Array<{ c: string }>;
      expect(Number(rows[0]?.c ?? 0)).toBe(0);
    });
  });

  // Bornes payload : properties (goal) + dimensions (ticket
  // ingest-properties-dimensions-non-bornees 2026-06-23).
  describe('POST /api/track — bornes properties / dimensions', () => {
    it('accepts a small flat properties map on a goal', async () => {
      const props = { plan: 'pro', source: 'ads' };
      const payload = createSessionPayload({
        actions: [createGoalAction({ properties: props })],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        .expect(200);
    });

    it('rejects a goal with too many properties keys', async () => {
      const huge: Record<string, string> = {};
      for (let i = 0; i < 100; i++) huge[`k${i}`] = 'v';

      const payload = createSessionPayload({
        actions: [createGoalAction({ properties: huge })],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        .expect(400);
    });

    it('rejects a goal with an over-long property value', async () => {
      const bigValue = 'x'.repeat(5000);
      const payload = createSessionPayload({
        actions: [createGoalAction({ properties: { big: bigValue } })],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        .expect(400);
    });

    it('rejects a goal with nested properties (depth)', async () => {
      const nested = { nested: { deep: 'value' } } as never;
      const payload = createSessionPayload({
        actions: [createGoalAction({ properties: nested })],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        .expect(400);
    });

    it('rejects a payload with too many dimensions keys', async () => {
      const huge: Record<string, string> = {};
      for (let i = 0; i < 100; i++) huge[`stm_${i}`] = 'v';

      const payload = createSessionPayload({
        dimensions: huge,
        actions: [createPageviewAction()],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        .expect(400);
    });
  });

  describe('Pages Materialized View', () => {
    it('creates page rows from pageview actions', async () => {
      const sessionId = `sess-pages-mv-${Date.now()}`;
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [
          createPageviewAction({
            path: '/home',
            page_number: 1,
            duration: 5000,
          }),
          createPageviewAction({
            path: '/about',
            page_number: 2,
            duration: 3000,
          }),
        ],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      // Wait for MV to process
      await waitForRowCount(
        workspaceClient,
        `SELECT count() as count FROM pages WHERE session_id = '${sessionId}'`,
        2,
      );

      const result = await workspaceClient.query({
        query: `SELECT page_id, path, page_number, duration, is_landing
                FROM pages FINAL
                WHERE session_id = {session_id:String}
                ORDER BY page_number`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const pages = await result.json();

      expect(pages).toHaveLength(2);
      expect(pages[0]).toMatchObject({
        page_id: `${sessionId}_1`,
        path: '/home',
        page_number: 1,
      });
      expect(Boolean(pages[0].is_landing)).toBe(true);
      expect(pages[1]).toMatchObject({
        page_id: `${sessionId}_2`,
        path: '/about',
        page_number: 2,
      });
      expect(Boolean(pages[1].is_landing)).toBe(false);
    });

    it('deduplicates pages with FINAL (ReplacingMergeTree)', async () => {
      const sessionId = `sess-pages-dedup-${Date.now()}`;

      // First payload
      const payload1 = createSessionPayload({
        session_id: sessionId,
        actions: [
          createPageviewAction({
            path: '/page',
            page_number: 1,
            duration: 5000,
            scroll: 30,
          }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload1)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      // Second payload - same page, updated values
      const payload2 = createSessionPayload({
        session_id: sessionId,
        actions: [
          createPageviewAction({
            path: '/page',
            page_number: 1,
            duration: 15000,
            scroll: 85,
          }),
        ],
        // No attributes (already sent), no checkpoint (testing dedup)
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload2)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      // Query with FINAL should return only 1 row with latest values
      const result = await workspaceClient.query({
        query: `SELECT page_id, duration, max_scroll
                FROM pages FINAL
                WHERE session_id = {session_id:String}`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const pages = await result.json();

      expect(pages).toHaveLength(1);
      expect(pages[0].duration).toBe(15000); // Latest value
      expect(pages[0].max_scroll).toBe(85); // Latest value
    });

    it('does not create page rows for goal events', async () => {
      const sessionId = `sess-no-goal-pages-${Date.now()}`;
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'signup', page_number: 1 }),
          createGoalAction({ name: 'purchase', page_number: 1 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      await waitForRowCount(
        workspaceClient,
        `SELECT count() as count FROM pages WHERE session_id = '${sessionId}'`,
        1, // Only 1 page (from pageview), not 3
      );

      const result = await workspaceClient.query({
        query: `SELECT count() as cnt FROM pages WHERE session_id = {session_id:String}`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const [{ cnt }] = await result.json();

      expect(Number(cnt)).toBe(1);
    });
  });

  describe('Sessions Materialized View', () => {
    it('aggregates goal_count and goal_value', async () => {
      const sessionId = `sess-goals-mv-${Date.now()}`;
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'add_to_cart', value: 50, page_number: 1 }),
          createGoalAction({ name: 'purchase', value: 150, page_number: 1 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      await waitForRowCount(
        workspaceClient,
        `SELECT count() as count FROM sessions FINAL WHERE id = '${sessionId}'`,
        1,
      );

      const result = await workspaceClient.query({
        query: `SELECT goal_count, goal_value
                FROM sessions FINAL
                WHERE id = {session_id:String}`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const [session] = await result.json();

      expect(session.goal_count).toBe(2);
      expect(session.goal_value).toBeCloseTo(200, 0);
    });

    it('counts pageviews separately from goals', async () => {
      const sessionId = `sess-pv-goal-count-${Date.now()}`;
      const payload = createSessionPayload({
        session_id: sessionId,
        actions: [
          createPageviewAction({ page_number: 1 }),
          createPageviewAction({ page_number: 2 }),
          createGoalAction({ name: 'signup', page_number: 2 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')

        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      await waitForRowCount(
        workspaceClient,
        `SELECT count() as count FROM sessions FINAL WHERE id = '${sessionId}'`,
        1,
      );

      const result = await workspaceClient.query({
        query: `SELECT pageview_count, goal_count
                FROM sessions FINAL
                WHERE id = {session_id:String}`,
        query_params: { session_id: sessionId },
        format: 'JSONEachRow',
      });
      const [session] = await result.json();

      expect(session.pageview_count).toBe(2);
      expect(session.goal_count).toBe(1);
    });
  });

  // ─── S6 Lot B — Canal referral interne `?ref=` (VRAI ClickHouse) ──────────
  //
  // Prouve que la branche 5bis de deriveChannel est CONSERVATRICE : elle
  // récupère du `direct` perdu en `referral` SANS jamais masquer un canal plus
  // riche. Le code parrain atterrit dans utm_content. 4 cas du ticket + 1 cas
  // de désactivation par workspace.
  //
  // ⚠️ Sabotage : retirer le parsing `?ref=` dans buildBaseEvent OU la branche
  //    5bis dans deriveChannel fait passer le cas (a) `referral` → `direct`
  //    (channel) et vide utm_content → la spec vire au ROUGE. C'est la preuve
  //    que le test mesure bien le fix et pas un mock.
  describe('POST /api/track — canal referral interne ?ref= (S6 Lot B)', () => {
    // Pour les workspaces autres que le défaut (test_ws_v3), le client par défaut
    // `workspaceClient` pointe sur la MAUVAISE DB → on ouvre un client scoped sur
    // la DB du workspace ciblé. On les ferme en afterEach pour ne pas fuiter.
    const extraClients: ClickHouseClient[] = [];
    function clientFor(wsId: string): ClickHouseClient {
      if (wsId === testWorkspaceId) return workspaceClient;
      const c = createClient({
        ...getSystemClientConfig(),
        database: getWorkspaceDatabaseName(wsId),
      });
      extraClients.push(c);
      return c;
    }
    afterEach(async () => {
      await Promise.all(extraClients.map((c) => c.close()));
      extraClients.length = 0;
    });

    async function trackAndReadSession(
      wsId: string,
      key: string,
      landingPage: string,
      referrer?: string,
    ): Promise<{
      channel: string;
      channel_group: string;
      utm_content: string;
    }> {
      const wsClient = clientFor(wsId);
      const sessionId = `sess-ref-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const payload = createSessionPayload({
        workspace_id: wsId,
        session_id: sessionId,
        actions: [createPageviewAction({ path: '/login', page_number: 1 })],
        attributes: { landing_page: landingPage, ...(referrer ? { referrer } : {}) },
      });

      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send(payload)
        .expect(200);

      await eventBuffer.flushAll();
      await waitForClickHouse();

      // events row carries the derived channel + utm_content.
      const evRes = await wsClient.query({
        query: `SELECT channel, channel_group, utm_content
                FROM events WHERE session_id = {sid:String} LIMIT 1`,
        query_params: { sid: sessionId },
        format: 'JSONEachRow',
      });
      const ev = (
        await evRes.json<{
          channel: string;
          channel_group: string;
          utm_content: string;
        }>()
      )[0];

      // and it fans out to the sessions MV (any(e.channel) / any(e.utm_content)).
      await waitForRowCount(
        wsClient,
        `SELECT count() as count FROM sessions FINAL WHERE id = '${sessionId}'`,
        1,
      );
      const sessRes = await wsClient.query({
        query: `SELECT channel, channel_group, utm_content
                FROM sessions FINAL WHERE id = {sid:String} LIMIT 1`,
        query_params: { sid: sessionId },
        format: 'JSONEachRow',
      });
      const sess = (
        await sessRes.json<{
          channel: string;
          channel_group: string;
          utm_content: string;
        }>()
      )[0];

      // events row IS the source of truth; assert the MV agrees with it.
      expect(sess?.channel).toBe(ev?.channel);
      expect(sess?.channel_group).toBe(ev?.channel_group);
      expect(sess?.utm_content).toBe(ev?.utm_content);
      return ev;
    }

    // (a) landing /login?ref=VHCRPP6X (referrer vide) → referral + utm_content.
    it('(a) ?ref=VHCRPP6X seul → channel=referral, group=referral, utm_content=code', async () => {
      const r = await trackAndReadSession(
        testWorkspaceId,
        apiKey,
        'https://app.example.com/login?ref=VHCRPP6X',
      );
      expect(r.channel).toBe('referral');
      expect(r.channel_group).toBe('referral');
      expect(r.utm_content).toBe('VHCRPP6X');
    });

    // (c) ?ref= + vrai referrer Google → reste search-organic (referrer prime).
    //     Le code parrain est tout de même conservé dans utm_content.
    it('(c) ?ref= + referrer google.com → reste organic_search/seo (canal riche non masqué)', async () => {
      const r = await trackAndReadSession(
        testWorkspaceId,
        apiKey,
        'https://app.example.com/login?ref=VHCRPP6X',
        'https://www.google.com/search?q=yoga',
      );
      expect(r.channel).toBe('organic_search');
      expect(r.channel_group).toBe('seo');
      // utm_content garde QUI parraine même si le canal est plus riche.
      expect(r.utm_content).toBe('VHCRPP6X');
    });

    // (d) landing sans ?ref= → direct inchangé, utm_content vide.
    it('(d) landing sans ?ref= → direct inchangé, utm_content vide', async () => {
      const r = await trackAndReadSession(
        testWorkspaceId,
        apiKey,
        'https://app.example.com/login',
      );
      expect(r.channel).toBe('direct');
      expect(r.channel_group).toBe('direct');
      expect(r.utm_content).toBe('');
    });

    // Configurable + désactivable par workspace (settings.referral_param).
    describe('referral_param configurable par workspace', () => {
      it('param custom "parrain" est parsé, "ref" ignoré', async () => {
        const wsId = 'test_ws_ref_custom';
        await createTestWorkspace(systemClient, wsId, {
          settings: { referral_param: 'parrain' },
        });
        const key = await createTestApiKey(systemClient, wsId);

        // ?parrain=ABC → referral
        const r1 = await trackAndReadSession(
          wsId,
          key,
          'https://app.example.com/login?parrain=ABC123',
        );
        expect(r1.channel).toBe('referral');
        expect(r1.utm_content).toBe('ABC123');

        // ?ref=ZZZ avec param custom "parrain" → le `ref` n'est PAS lu → direct
        const r2 = await trackAndReadSession(
          wsId,
          key,
          'https://app.example.com/login?ref=ZZZ',
        );
        expect(r2.channel).toBe('direct');
        expect(r2.utm_content).toBe('');
      });

      it('referral_param="" DÉSACTIVE le parsing (?ref= ignoré → direct)', async () => {
        const wsId = 'test_ws_ref_disabled';
        await createTestWorkspace(systemClient, wsId, {
          settings: { referral_param: '' },
        });
        const key = await createTestApiKey(systemClient, wsId);

        const r = await trackAndReadSession(
          wsId,
          key,
          'https://app.example.com/login?ref=VHCRPP6X',
        );
        expect(r.channel).toBe('direct');
        expect(r.channel_group).toBe('direct');
        expect(r.utm_content).toBe('');
      });
    });
  });
});
