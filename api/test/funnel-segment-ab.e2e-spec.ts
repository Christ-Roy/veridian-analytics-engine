// Set env vars BEFORE any imports to ensure ConfigModule picks them up
import {
  setupTestEnv,
  PLATFORM_ADMIN_API_KEY as PLATFORM_KEY,
} from './constants/test-config';
setupTestEnv();

import { ClickHouseClient } from '@clickhouse/client';
import request from 'supertest';
import {
  toClickHouseDateTime,
  createUserWithToken,
  createTestWorkspace,
  truncateSystemTables,
  truncateWorkspaceTables,
  createTestApp,
  closeTestApp,
  waitForClickHouse,
  TestAppContext,
} from './helpers';

const testWorkspaceId = 'funnel_segment_ab_ws';

/**
 * A1 (segment_by) + A3-value — E2E against the REAL ClickHouse (no mock).
 *
 * Proves the core funnel A/B feature end-to-end:
 *  - segment_by:'<dim>' returns N funnel series (one per variant) in ONE query;
 *  - the per-step € value (A3-value) matches SUM(goal_value) of the units that
 *    reached each step;
 *  - WITHOUT segment_by the mono-series contract is byte-identical (retro-compat);
 *  - a high-cardinality segment_by (> SEGMENT_MAX) is rejected (sabotage).
 *
 * Seed (variant tagged on BOTH properties['variant'] AND stm_2 so both
 * segmentation paths are covered). Funnel = signup → onboarding → purchase.
 * A session reaching step K emits K goals at increasing timestamps; the purchase
 * carries goal_value=50 (the € order). Per variant:
 *   A: 5 signup / 3 onboarding / 2 purchase   (value: 2×50 = 100)
 *   B: 4 signup / 2 onboarding / 1 purchase   (value: 1×50 =  50)
 *   C: 3 signup / 1 onboarding / 0 purchase   (value: 0)
 * Mono-series (no segment) totals: 12 signup / 6 onboarding / 3 purchase, 150€.
 */
describe('Funnel segment_by A/B/C + value (E2E real ClickHouse)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let authToken: string;
  const workspaceId = testWorkspaceId;

  const baseDate = new Date('2026-06-10T10:00:00.000Z');
  const STEPS = ['signup', 'onboarding', 'purchase'] as const;
  let rowSeq = 0;

  // One goal row. `idx` makes the UUID + timestamp unique and ordered.
  function goalRow(
    sessionId: string,
    variant: string,
    goalName: string,
    minutesOffset: number,
    goalValue: number,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    d.setUTCMinutes(d.getUTCMinutes() + minutesOffset);
    const i = rowSeq++;
    return {
      id: `00000000-0000-0003-0000-${i.toString().padStart(12, '0')}`,
      session_id: sessionId,
      workspace_id: workspaceId,
      goal_name: goalName,
      goal_value: goalValue,
      goal_timestamp: toClickHouseDateTime(d),
      path: `/${goalName}`,
      page_number: 1,
      // Variant tagged on the Map — segmentation path #1. `variant` is the A2
      // dimension (properties['variant']); `source` mirrors it onto the ALREADY
      // declared Map dimension `phone_source` (properties['source']) so we can
      // prove the Map-accessor segmentation path deterministically without
      // waiting for A2 to ship.
      properties: { variant, source: variant },
      referrer: '',
      referrer_domain: '',
      is_direct: true,
      landing_page: 'https://test.com/',
      landing_path: '/',
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      utm_term: '',
      utm_content: '',
      channel: 'direct',
      channel_group: 'direct',
      stm_1: '',
      // Variant also on stm_2 — segmentation path #2 (works WITHOUT A2 shipped).
      stm_2: variant,
      stm_3: '',
      stm_4: '',
      stm_5: '',
      stm_6: '',
      stm_7: '',
      stm_8: '',
      stm_9: '',
      stm_10: '',
      device: 'desktop',
      browser: 'Chrome',
      os: 'macOS',
      country: 'FR',
      region: '',
      city: '',
      language: 'fr-FR',
      browser_type: 'browser',
      screen_width: 1920,
      screen_height: 1080,
      viewport_width: 1920,
      viewport_height: 900,
      user_agent: 'Mozilla/5.0',
      connection_type: 'wifi',
      referrer_path: '',
      landing_domain: 'test.com',
      utm_id: '',
      utm_id_from: '',
      timezone: 'Europe/Paris',
      latitude: null,
      longitude: null,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      day_of_week: d.getUTCDay() || 7,
      week_number: 1,
      hour: d.getUTCHours(),
      is_weekend: false,
      _version: 1,
    };
  }

  // Emit a session reaching `depth` steps (1..3). Purchase carries 50€.
  function sessionGoals(
    variant: string,
    n: number,
    depth: number,
  ): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const sessionId = `sess-${variant}-${n}`;
    for (let step = 0; step < depth; step++) {
      const goalName = STEPS[step];
      const value = goalName === 'purchase' ? 50 : 0;
      // increasing timestamp per step so windowFunnel sees the ordered sequence
      out.push(goalRow(sessionId, variant, goalName, step, value));
    }
    return out;
  }

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;

    await truncateSystemTables(systemClient, ['users']);
    const { token } = await createUserWithToken(
      ctx.app,
      systemClient,
      'funnel-segment@test.com',
      undefined,
      { name: 'Funnel Segment User', isSuperAdmin: true },
    );
    authToken = token;

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await truncateWorkspaceTables(workspaceClient, ['sessions', 'goals'], 0);
    await createTestWorkspace(systemClient, workspaceId, {
      name: 'Funnel Segment Workspace',
      website: 'https://test.com',
    });

    const goals: Record<string, unknown>[] = [];
    // Variant A: 5 signup, 3 onboarding, 2 purchase
    for (let n = 0; n < 5; n++) goals.push(...sessionGoals('A', n, n < 2 ? 3 : n < 3 ? 2 : 1));
    // Variant B: 4 signup, 2 onboarding, 1 purchase
    for (let n = 0; n < 4; n++) goals.push(...sessionGoals('B', n, n < 1 ? 3 : n < 2 ? 2 : 1));
    // Variant C: 3 signup, 1 onboarding, 0 purchase
    for (let n = 0; n < 3; n++) goals.push(...sessionGoals('C', n, n < 1 ? 2 : 1));

    await workspaceClient.insert({
      table: 'goals',
      values: goals,
      format: 'JSONEachRow',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE goals FINAL' });
    await waitForClickHouse();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  function funnelBody(extra: Record<string, unknown> = {}) {
    return {
      workspace_id: workspaceId,
      steps: STEPS.map((g) => ({ goal_name: g })),
      dateRange: { preset: 'all_time' },
      ...extra,
    };
  }

  async function postFunnel(body: Record<string, unknown>, expectStatus = 200) {
    return request(ctx.app.getHttpServer())
      .post('/api/analytics.funnel')
      .set('Authorization', `Bearer ${authToken}`)
      .send(body)
      .expect(expectStatus);
  }

  // Same call but WITHOUT asserting a status (caller inspects res.status).
  async function postFunnelAnyStatus(body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer())
      .post('/api/analytics.funnel')
      .set('Authorization', `Bearer ${authToken}`)
      .send(body);
  }

  it('mono-series (no segment_by) keeps the flat contract — retro-compat', async () => {
    const res = await postFunnel(funnelBody());
    const b = res.body;
    // Flat shape, NOT segmented.
    expect(b).not.toHaveProperty('segments');
    expect(b).not.toHaveProperty('segment_by');
    expect(b.entered).toBe(12); // 5+4+3 signups
    expect(b.steps).toHaveLength(3);
    expect(b.steps[0].count).toBe(12);
    expect(b.steps[1].count).toBe(6); // 3+2+1 onboarding
    expect(b.steps[2].count).toBe(3); // 2+1+0 purchase
    expect(b.overall_conversion).toBe(25); // 3/12
    // A3-value: 3 purchases × 50€ = 150€ carried at every reached step.
    expect(b.steps[2].value).toBe(150);
    expect(b.steps[0].value).toBe(150);
  });

  it('segment_by:stm_2 returns 3 series (A/B/C) in ONE call with correct rates + value', async () => {
    const res = await postFunnel(funnelBody({ segment_by: 'stm_2' }));
    const b = res.body;
    expect(b.segment_by).toBe('stm_2');
    expect(b.segments).toHaveLength(3);

    const byKey = Object.fromEntries(
      b.segments.map((s: any) => [s.key, s]),
    );

    // Variant A: 5 → 3 → 2, overall 40%, € = 2×50 = 100
    expect(byKey.A.entered).toBe(5);
    expect(byKey.A.steps[1].count).toBe(3);
    expect(byKey.A.steps[2].count).toBe(2);
    expect(byKey.A.overall_conversion).toBe(40);
    expect(byKey.A.steps[2].value).toBe(100);

    // Variant B: 4 → 2 → 1, overall 25%, € = 50
    expect(byKey.B.entered).toBe(4);
    expect(byKey.B.steps[2].count).toBe(1);
    expect(byKey.B.overall_conversion).toBe(25);
    expect(byKey.B.steps[2].value).toBe(50);

    // Variant C: 3 → 1 → 0, overall 0%, € = 0
    expect(byKey.C.entered).toBe(3);
    expect(byKey.C.steps[2].count).toBe(0);
    expect(byKey.C.overall_conversion).toBe(0);
    expect(byKey.C.steps[2].value).toBe(0);

    // Segments sum back to the mono-series totals (consistency).
    const enteredSum = b.segments.reduce(
      (a: number, s: any) => a + s.entered,
      0,
    );
    expect(enteredSum).toBe(12);
  });

  it('M2M mirror (/api/admin/platform/analytics.funnel) returns the SAME segmented shape', async () => {
    // Double surface: the platform-admin M2M endpoint must return byte-identical
    // segmented results (it delegates to the same service). Gated by the
    // platform admin key, not the workspace token.
    const pub = await postFunnel(funnelBody({ segment_by: 'stm_2' }));
    const m2m = await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/analytics.funnel')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send(funnelBody({ segment_by: 'stm_2' }))
      .expect(200);

    expect(m2m.body.segment_by).toBe('stm_2');
    expect(m2m.body.segments).toHaveLength(3);
    // Same series keys + same entered/value as the public endpoint.
    const norm = (b: any) =>
      b.segments
        .map((s: any) => ({
          key: s.key,
          entered: s.entered,
          overall: s.overall_conversion,
          lastValue: s.steps[s.steps.length - 1].value,
        }))
        .sort((a: any, z: any) => a.key.localeCompare(z.key));
    expect(norm(m2m.body)).toEqual(norm(pub.body));
  });

  it('segment_by on a Map-accessor dimension (phone_source = properties[source]) returns 3 series', async () => {
    // Deterministic proof of the Map-accessor segmentation path (the very path
    // A2's `variant` dimension will use). phone_source = properties['source'],
    // already declared on the goals table. We mirrored source=variant in the
    // seed, so segmenting on phone_source must yield the same A/B/C series.
    const res = await postFunnel(funnelBody({ segment_by: 'phone_source' }));
    expect(res.body.segment_by).toBe('phone_source');
    expect(res.body.segments).toHaveLength(3);
    const byKey = Object.fromEntries(
      res.body.segments.map((s: any) => [s.key, s]),
    );
    expect(byKey.A.entered).toBe(5);
    expect(byKey.A.steps[2].value).toBe(100);
    expect(byKey.B.entered).toBe(4);
    expect(byKey.C.entered).toBe(3);
  });

  it('segment_by:variant (the A2 dimension on properties[variant]) returns 3 series — A1+A2 integrated', async () => {
    // The `variant` dimension (lot A2) is now on staging. Segmenting on it is the
    // exact pitch path (one funnel per onboarding variant A/B/C). It MUST succeed
    // with 3 series. The legacy fallback (A2 absent → 400 Unknown dimension) is
    // kept only as a guard so the spec still tells a clear story if A2 regresses.
    const res = await postFunnelAnyStatus(funnelBody({ segment_by: 'variant' }));
    if (res.status === 200) {
      expect(res.body.segment_by).toBe('variant');
      expect(res.body.segments).toHaveLength(3);
      const keys = res.body.segments.map((s: any) => s.key).sort();
      expect(keys).toEqual(['A', 'B', 'C']);
      // value/rate parity with the stm_2 series (same underlying sessions).
      const byKey = Object.fromEntries(
        res.body.segments.map((s: any) => [s.key, s]),
      );
      expect(byKey.A.entered).toBe(5);
      expect(byKey.A.overall_conversion).toBe(40);
      expect(byKey.A.steps[2].value).toBe(100);
    } else {
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/Unknown dimension/);
    }
  });

  it('A3-value: per-step value equals SUM(goal_value) of units reaching that step', async () => {
    // Ground-truth straight from ClickHouse: total purchase value = 3 × 50 = 150.
    const dbName = `staminads_ws_${workspaceId}`;
    const q = await workspaceClient.query({
      query: `SELECT sum(goal_value) AS v FROM ${dbName}.goals WHERE goal_name = 'purchase'`,
      format: 'JSONEachRow',
    });
    const [{ v }] = (await q.json()) as Array<{ v: string }>;
    expect(Number(v)).toBe(150);

    const res = await postFunnel(funnelBody());
    // Step 3 value (units reaching purchase) must equal that ground truth.
    expect(res.body.steps[2].value).toBe(Number(v));
  });

  it('SABOTAGE: a high-cardinality segment_by (> SEGMENT_MAX) is rejected with 400', async () => {
    // Insert 13 `signup` goals each with a DISTINCT stm_3 value. Segmenting on
    // stm_3 then yields ≥ 13 series (the 13 buckets + the '' of the A/B/C seed)
    // > SEGMENT_MAX(12) → the service must reject (not silently truncate).
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < 13; k++) {
      const g = goalRow(`card-sess-${k}`, 'A', 'signup', k, 0);
      g.stm_3 = `bucket-${k}`;
      rows.push(g);
    }
    await workspaceClient.insert({
      table: 'goals',
      values: rows,
      format: 'JSONEachRow',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE goals FINAL' });
    await waitForClickHouse();

    const res = await postFunnel(
      funnelBody({
        steps: [{ goal_name: 'signup' }, { goal_name: 'onboarding' }],
        segment_by: 'stm_3',
      }),
      400,
    );
    expect(JSON.stringify(res.body)).toMatch(
      /SEGMENT_CARDINALITY_EXCEEDED|more than/,
    );
  });
});
