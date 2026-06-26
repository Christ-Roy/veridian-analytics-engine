// Set env vars BEFORE any imports so ConfigModule picks them up.
import {
  setupTestEnv,
  PLATFORM_ADMIN_API_KEY as PLATFORM_KEY,
} from './constants/test-config';
setupTestEnv();

import { ClickHouseClient } from '@clickhouse/client';
import request from 'supertest';
import {
  toClickHouseDateTime,
  createTestWorkspace,
  truncateSystemTables,
  truncateWorkspaceTables,
  createTestApp,
  closeTestApp,
  waitForClickHouse,
  TestAppContext,
} from './helpers';

/**
 * VAGUE 2 — Named, persisted funnels per workspace (M2M).
 *
 * Proves the full data-driven loop against REAL ClickHouse (no mock — a mock
 * would hide a broken windowFunnel resolution, cf memory
 * `feedback_mock_cache_le_bug_tester_clickhouse_reel`):
 *   1. funnels.set persists a named funnel "rdv" (the vitrine tracker:
 *      appointment_click → rdv_booked → form_submission) in settings JSON.
 *   2. funnels.get reads it back (persistence roundtrip).
 *   3. funnels.run "rdv" resolves the PERSISTED steps and runs the real
 *      windowFunnel engine → correct per-step counts.
 *   4. Sabotage: unknown name → 404 FUNNEL_NOT_FOUND ; < 2 steps → 400 ;
 *      duplicate name → 400 ; bad slug → 400.
 *
 * The funnel "rdv" is a phone/contact funnel — exactly Robert's case where the
 * conversion tracker varies by client type.
 */
const wsId = 'named_funnels_ws';

describe('Named funnels M2M (E2E real ClickHouse)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;

  const baseDate = new Date('2026-06-10T10:00:00.000Z');

  // Build a goals row (mirrors the durable `goals` table shape used by the
  // funnel engine; channel_group propagated by goals_mv in prod, seeded here).
  function goalRow(
    i: number,
    sessionId: string,
    goalName: string,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    d.setUTCMinutes(d.getUTCMinutes() + i);
    return {
      id: `00000000-0000-0007-0000-0000000000${i.toString().padStart(2, '0')}`,
      session_id: sessionId,
      workspace_id: wsId,
      goal_name: goalName,
      goal_value: 0,
      goal_timestamp: toClickHouseDateTime(d),
      path: '/contact',
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
      channel: 'seo',
      channel_group: 'seo',
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
    ctx = await createTestApp({ workspaceId: wsId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await truncateWorkspaceTables(workspaceClient, ['goals'], 0);
    await createTestWorkspace(systemClient, wsId, {
      name: 'Named Funnels Workspace',
      website: 'https://test.com',
    });

    // Funnel "rdv": appointment_click → rdv_booked → form_submission.
    // Seed 3 sessions with decreasing depth so each step has a distinct count:
    //   sess-A: all 3 steps           → reaches step 3
    //   sess-B: steps 1 + 2           → reaches step 2
    //   sess-C: step 1 only           → reaches step 1
    // Expected per step (session unit): [3, 2, 1].
    const goals = [
      // sess-A — full funnel (steps must be IN ORDER for windowFunnel)
      goalRow(0, 'sess-A', 'appointment_click'),
      goalRow(1, 'sess-A', 'rdv_booked'),
      goalRow(2, 'sess-A', 'form_submission'),
      // sess-B — first two steps
      goalRow(3, 'sess-B', 'appointment_click'),
      goalRow(4, 'sess-B', 'rdv_booked'),
      // sess-C — first step only
      goalRow(5, 'sess-C', 'appointment_click'),
      // noise goal that is NOT a funnel step (must not affect counts)
      goalRow(6, 'sess-C', 'newsletter_signup'),
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

  const m2m = (route: string, body: Record<string, unknown>) =>
    request(ctx.app.getHttpServer())
      .post(`/api/admin/platform/${route}`)
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send(body);

  it('funnels.set persists a named funnel and funnels.get reads it back', async () => {
    const setRes = await m2m('funnels.set', {
      workspace_id: wsId,
      funnels: [
        {
          name: 'rdv',
          label: 'Tunnel prise de RDV',
          steps: [
            { goal_name: 'appointment_click', label: 'Demande RDV' },
            { goal_name: 'rdv_booked', label: 'RDV confirmé' },
            { goal_name: 'form_submission', label: 'Contact' },
          ],
          default_unit: 'session',
        },
      ],
    }).expect(200);

    // set* verbs return the customization snapshot, now carrying `funnels`.
    expect(setRes.body.funnels).toHaveLength(1);
    expect(setRes.body.funnels[0].name).toBe('rdv');

    const getRes = await m2m('funnels.get', { workspace_id: wsId }).expect(200);
    expect(getRes.body.workspace_id).toBe(wsId);
    expect(getRes.body.funnels).toHaveLength(1);
    const f = getRes.body.funnels[0];
    expect(f.name).toBe('rdv');
    expect(f.label).toBe('Tunnel prise de RDV');
    expect(f.steps.map((s: { goal_name: string }) => s.goal_name)).toEqual([
      'appointment_click',
      'rdv_booked',
      'form_submission',
    ]);
    expect(f.default_unit).toBe('session');
  });

  it('funnels.run resolves the PERSISTED steps and computes correct counts', async () => {
    const res = await m2m('funnels.run', {
      workspace_id: wsId,
      name: 'rdv',
      dateRange: { preset: 'all_time' },
    }).expect(200);

    expect(res.body.funnel_name).toBe('rdv');
    expect(res.body.funnel_label).toBe('Tunnel prise de RDV');
    expect(res.body.unit).toBe('session');
    expect(res.body.entered).toBe(3);
    expect(res.body.steps).toHaveLength(3);

    const counts = res.body.steps.map((s: { count: number }) => s.count);
    // sess-A,B,C reach step1; A,B reach step2; A reaches step3.
    expect(counts).toEqual([3, 2, 1]);

    // Labels come from the persisted definition, not the goal_name.
    expect(res.body.steps[0].label).toBe('Demande RDV');
    expect(res.body.steps[2].label).toBe('Contact');

    // End-to-end conversion = last/entered = 1/3 ≈ 33.33%.
    expect(res.body.overall_conversion).toBeCloseTo(33.33, 1);
  });

  it('funnels.run is case-insensitive on the name (RDV resolves rdv)', async () => {
    const res = await m2m('funnels.run', {
      workspace_id: wsId,
      name: 'RDV',
      dateRange: { preset: 'all_time' },
    }).expect(200);
    expect(res.body.funnel_name).toBe('rdv');
    expect(res.body.entered).toBe(3);
  });

  it('SABOTAGE: unknown funnel name → 404 FUNNEL_NOT_FOUND (clean, not 500)', async () => {
    const res = await m2m('funnels.run', {
      workspace_id: wsId,
      name: 'does_not_exist',
      dateRange: { preset: 'all_time' },
    }).expect(404);
    expect(res.body.code).toBe('FUNNEL_NOT_FOUND');
    expect(res.body.statusCode).toBe(404);
    // The error lists the available funnels to help the caller.
    expect(res.body.message).toContain('rdv');
  });

  it('SABOTAGE: a funnel with < 2 steps is rejected at definition time (400)', async () => {
    const res = await m2m('funnels.set', {
      workspace_id: wsId,
      funnels: [
        { name: 'broken', steps: [{ goal_name: 'only_one' }] },
      ],
    }).expect(400);
    expect(res.body.statusCode).toBe(400);
    // The previously persisted 'rdv' funnel must be untouched by the rejected write.
    const getRes = await m2m('funnels.get', { workspace_id: wsId }).expect(200);
    expect(getRes.body.funnels.map((f: { name: string }) => f.name)).toContain(
      'rdv',
    );
  });

  it('SABOTAGE: duplicate funnel names in one body → 400 DUPLICATE_FUNNEL_NAME', async () => {
    // Same valid slug twice → passes the DTO (slug regex ok) but fails the
    // service-level uniqueness check. (Slugs are lowercase-only, so the
    // case-insensitive dedup is exercised at run time via funnels.run, not here.)
    const res = await m2m('funnels.set', {
      workspace_id: wsId,
      funnels: [
        { name: 'dup', steps: [{ goal_name: 'a' }, { goal_name: 'b' }] },
        { name: 'dup', steps: [{ goal_name: 'c' }, { goal_name: 'd' }] },
      ],
    }).expect(400);
    expect(res.body.code).toBe('DUPLICATE_FUNNEL_NAME');
  });

  it('SABOTAGE: an invalid funnel name slug is rejected (400)', async () => {
    await m2m('funnels.set', {
      workspace_id: wsId,
      funnels: [
        { name: 'has spaces!', steps: [{ goal_name: 'a' }, { goal_name: 'b' }] },
      ],
    }).expect(400);
  });

  it('funnels.set with [] clears the catalogue, then funnels.run → 404', async () => {
    await m2m('funnels.set', { workspace_id: wsId, funnels: [] }).expect(200);
    const getRes = await m2m('funnels.get', { workspace_id: wsId }).expect(200);
    expect(getRes.body.funnels).toEqual([]);

    const runRes = await m2m('funnels.run', {
      workspace_id: wsId,
      name: 'rdv',
      dateRange: { preset: 'all_time' },
    }).expect(404);
    expect(runRes.body.code).toBe('FUNNEL_NOT_FOUND');
    expect(runRes.body.message).toContain('no persisted funnel');

    // Re-seed 'rdv' so suite order independence is preserved if extended.
    await m2m('funnels.set', {
      workspace_id: wsId,
      funnels: [
        {
          name: 'rdv',
          steps: [
            { goal_name: 'appointment_click' },
            { goal_name: 'rdv_booked' },
            { goal_name: 'form_submission' },
          ],
        },
      ],
    }).expect(200);
  });

  it('SABOTAGE: unknown workspace → 404 WORKSPACE_NOT_FOUND on every verb', async () => {
    await m2m('funnels.get', { workspace_id: 'nope_ws' }).expect(404);
    await m2m('funnels.set', { workspace_id: 'nope_ws', funnels: [] }).expect(
      404,
    );
    await m2m('funnels.run', {
      workspace_id: 'nope_ws',
      name: 'rdv',
      dateRange: { preset: 'all_time' },
    }).expect(404);
  });
});
