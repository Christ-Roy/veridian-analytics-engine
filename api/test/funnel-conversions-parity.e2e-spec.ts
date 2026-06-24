// Set env vars BEFORE any imports to ensure ConfigModule picks them up
import { setupTestEnv } from './constants/test-config';
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

const testWorkspaceId = 'funnel_conv_parity_ws';

/**
 * Ticket 2026-06-24-funnel-vs-conversions-meme-goal-divergent.
 *
 * Invariant produit : pour un même goal, le tunnel (step 1) et la somme des
 * conversions par canal (`conversionsByChannel`) doivent compter le MÊME nombre
 * de sessions converties. Avant le fix, le funnel appliquait `AND session_id !=
 * ''` (mode session) mais pas `conversionsByChannel` → divergence dès qu'un goal
 * orphelin (session_id vide) existait. Le fix aligne les deux sur la définition
 * « une conversion = une session convertie (session_id non vide) ».
 *
 * Ce spec tape le VRAI ClickHouse (pas de mock). Il sème un goal orphelin
 * (session_id='') pour reproduire exactement la condition de divergence, et
 * prouve que funnel(step1) == sum(conversions) APRÈS fix.
 */
describe('Funnel vs conversionsByChannel parity (E2E real ClickHouse)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let authToken: string;
  const workspaceId = testWorkspaceId;

  // Goal seed:
  //  - 4 web signups, 2 distinct channel_groups, all with non-empty session_id
  //  - 1 server-to-server signup (synthetic voip session_id, channel_group=seo)
  //  - 1 ORPHAN signup with EMPTY session_id (the divergence trigger)
  // Expected after fix: both surfaces count 5 (4 web + 1 S2S), orphan excluded.
  const baseDate = new Date('2026-06-10T10:00:00.000Z');
  const GOAL = 'signup';

  function goalRow(
    i: number,
    sessionId: string,
    channelGroup: string,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    d.setUTCMinutes(d.getUTCMinutes() + i);
    return {
      id: `00000000-0000-0002-0000-0000000000${i.toString().padStart(2, '0')}`,
      session_id: sessionId,
      workspace_id: workspaceId,
      goal_name: GOAL,
      goal_value: 0,
      goal_timestamp: toClickHouseDateTime(d),
      path: '/signup',
      page_number: 1,
      properties: {},
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
      channel: channelGroup,
      channel_group: channelGroup,
      stm_1: '',
      stm_2: '',
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

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;

    await truncateSystemTables(systemClient, ['users']);
    const { token } = await createUserWithToken(
      ctx.app,
      systemClient,
      'funnel-parity@test.com',
      undefined,
      { name: 'Funnel Parity User', isSuperAdmin: true },
    );
    authToken = token;

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await truncateWorkspaceTables(workspaceClient, ['sessions', 'goals'], 0);
    await createTestWorkspace(systemClient, workspaceId, {
      name: 'Funnel Parity Workspace',
      website: 'https://test.com',
    });

    const goals = [
      goalRow(0, 'web-sess-1', 'direct'),
      goalRow(1, 'web-sess-2', 'direct'),
      goalRow(2, 'web-sess-3', 'seo'),
      goalRow(3, 'web-sess-4', 'seo'),
      // server-to-server goal: synthetic session_id, real channel_group
      goalRow(4, 'voip:ovh:call-xyz', 'seo'),
      // ORPHAN goal: empty session_id (divergence trigger). MUST NOT be counted.
      goalRow(5, '', 'direct'),
    ];

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

  async function funnelStep1Count(): Promise<number> {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/analytics.funnel')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: workspaceId,
        steps: [{ goal_name: GOAL }, { goal_name: 'app_started' }],
        dateRange: { preset: 'all_time' },
      })
      .expect(200);
    return res.body.entered as number;
  }

  async function conversionsSum(): Promise<{ sum: number; rows: any[] }> {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/analytics.conversionsByChannel')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: workspaceId,
        dateRange: { preset: 'all_time' },
        conversion_goals: [GOAL],
      })
      .expect(200);
    const rows = res.body.rows as Array<{ conversions: number }>;
    const sum = rows.reduce((acc, r) => acc + Number(r.conversions), 0);
    return { sum, rows };
  }

  it('funnel(step1) == sum(conversionsByChannel) for the same goal — orphan excluded', async () => {
    const funnelEntered = await funnelStep1Count();
    const { sum, rows } = await conversionsSum();

    // 4 web + 1 S2S = 5 real converted sessions; the empty-session_id orphan is
    // excluded by BOTH surfaces now.
    expect(funnelEntered).toBe(5);
    expect(sum).toBe(5);
    expect(funnelEntered).toBe(sum);

    // No conversion row may carry an empty channel for an empty session_id —
    // the orphan must not surface at all.
    const orphanCounted = rows.some(
      (r) => r.channel_group === 'direct' && Number(r.conversions) > 2,
    );
    expect(orphanCounted).toBe(false);
  });

  it('SABOTAGE: a query WITHOUT the session_id guard over-counts (proves the fix matters)', async () => {
    // Reproduce the pre-fix conversions query directly against ClickHouse,
    // i.e. WITHOUT `AND session_id != ''`. It must over-count vs the funnel,
    // proving the guard is load-bearing (not cosmetic).
    const dbName = `staminads_ws_${workspaceId}`;
    const unguarded = await workspaceClient.query({
      query: `SELECT channel_group, uniqExact(session_id) AS conversions
              FROM ${dbName}.goals
              WHERE goal_name = 'signup'
              GROUP BY channel_group`,
      format: 'JSONEachRow',
    });
    const rows = (await unguarded.json()) as Array<{ conversions: string }>;
    const unguardedSum = rows.reduce((a, r) => a + Number(r.conversions), 0);

    // The orphan (session_id='') collapses into a uniqExact bucket = +1 in its
    // channel_group → unguarded total is 6, but the funnel (and the fixed
    // conversions) count 5. Divergence reproduced when the guard is removed.
    expect(unguardedSum).toBe(6);
    const funnelEntered = await funnelStep1Count();
    expect(unguardedSum).toBeGreaterThan(funnelEntered);
  });
});
