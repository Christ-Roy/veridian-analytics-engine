// Env vars BEFORE any import so ConfigModule snapshots them.
import {
  setupTestEnv,
  PLATFORM_ADMIN_API_KEY as PLATFORM_KEY,
  getSystemClientConfig,
} from './constants/test-config';
setupTestEnv();

import request from 'supertest';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { AppModule } from '../src/app.module';
import { PlatformAdminGuard } from '../src/admin-platform/guards/platform-admin.guard';
import { MailService } from '../src/mail/mail.service';
import { closeTestApp, TestAppContext } from './helpers/app.helper';
import { truncateSystemTables } from './helpers/cleanup.helper';
import { toClickHouseDateTime } from './helpers/datetime.helper';

/**
 * Demo-mode tenant (M2M demo.seed / demo.wipe / demo.status).
 *
 * Validates the strategy's core promise against a REAL ClickHouse:
 *   1. After seed, 100% of mock rows carry the vrddemo_ session_id prefix
 *      (web + voip + goals) AND the _demo=1 property tag on events.
 *   2. THE TTL SCENARIO (the test the tag-properties-only approach would fail):
 *      sessions/goals rows whose events were already purged (TTL 7d) are STILL
 *      wiped, because the wipe keys on the session_id PREFIX, not on events.
 *   3. SABOTAGE — real data preservation: a workspace with BOTH real and mock
 *      data → wipe removes only the mock; the real rows are byte-for-byte
 *      identical before/after (preserved_real.intact === true).
 *   4. The seed guard refuses (409 DEMO_REAL_DATA_PRESENT) over real data
 *      unless force:true.
 *   5. A wipe on a workspace with no demo data is a clean no-op.
 */

const ADMIN = '/api/admin/platform';

async function createApp(): Promise<TestAppContext> {
  const overrideGuard = {
    canActivate: (ctx: import('@nestjs/common').ExecutionContext): boolean => {
      const req = ctx.switchToHttp().getRequest();
      const auth = req.headers?.authorization as string | undefined;
      const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
      if (!m || m[1].trim() !== PLATFORM_KEY) {
        throw new (require('@nestjs/common').UnauthorizedException)('bad key');
      }
      return true;
    },
  };

  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(PlatformAdminGuard)
    .useValue(overrideGuard)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const systemClient = createClient(getSystemClientConfig());
  const mailService = moduleFixture.get<MailService>(MailService);
  jest.spyOn(mailService, 'sendPasswordReset').mockResolvedValue();

  return { app, moduleFixture, systemClient, mailService };
}

function wsClient(workspaceId: string): ClickHouseClient {
  return createClient({
    ...getSystemClientConfig(),
    database: `staminads_ws_${workspaceId}`,
  });
}

async function insertWorkspaceRow(
  systemClient: ClickHouseClient,
  id: string,
  website: string,
): Promise<void> {
  const now = toClickHouseDateTime();
  await systemClient.insert({
    table: 'workspaces',
    values: [
      {
        id,
        name: `Demo ${id}`,
        website,
        timezone: 'Europe/Paris',
        currency: 'EUR',
        status: 'active',
        settings: JSON.stringify({ timescore_reference: 60, bounce_threshold: 10 }),
        created_at: now,
        updated_at: now,
      },
    ],
    format: 'JSONEachRow',
  });
}

async function count(
  client: ClickHouseClient,
  table: string,
  where: string,
): Promise<number> {
  const r = await client.query({
    query: `SELECT count() AS c FROM ${table} FINAL WHERE ${where}`,
    format: 'JSONEachRow',
  });
  const rows = (await r.json()) as Array<{ c: string }>;
  return Number(rows[0]?.c ?? 0);
}

async function truncate(client: ClickHouseClient, tables: string[]): Promise<void> {
  for (const t of tables) {
    await client.command({ query: `TRUNCATE TABLE IF EXISTS ${t}` });
  }
}

describe('Demo-mode tenant (M2M) — seed / wipe / status', () => {
  let ctx: TestAppContext;
  const DEMO_WS = 'demo_tenant_test_ws';
  const REAL_WS = 'demo_tenant_real_ws';
  let demoCh: ClickHouseClient;
  let realCh: ClickHouseClient;

  beforeAll(async () => {
    ctx = await createApp();
    demoCh = wsClient(DEMO_WS);
    realCh = wsClient(REAL_WS);
  });

  afterAll(async () => {
    await demoCh.close();
    await realCh.close();
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncateSystemTables(ctx.systemClient, ['workspaces', 'backfill_tasks']);
    await truncate(demoCh, ['events', 'sessions', 'pages', 'goals']);
    await truncate(realCh, ['events', 'sessions', 'pages', 'goals']);
  });

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${PLATFORM_KEY}`);

  it('seed tags 100% of mock rows with the vrddemo_ prefix (web + voip + goals)', async () => {
    await insertWorkspaceRow(ctx.systemClient, DEMO_WS, 'https://client-demo.fr');

    const res = await auth(
      request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.seed`),
    )
      .send({ workspace_id: DEMO_WS, session_count: 400, voip_count: 30, days_range: 20 })
      .expect(200);

    expect(res.body.is_demo).toBe(true);
    expect(res.body.run_id).toMatch(/^[0-9a-f]{8}$/);
    expect(res.body.seeded.web_sessions).toBe(400);
    expect(res.body.seeded.voip_calls).toBe(30);
    expect(res.body.mock_rows.events).toBeGreaterThan(0);
    expect(res.body.mock_rows.sessions).toBeGreaterThan(0);
    expect(res.body.mock_rows.goals).toBeGreaterThanOrEqual(30); // ≥ voip calls

    // NO real rows exist → all rows are demo-prefixed. Assert ZERO non-prefixed.
    for (const [table, col] of [
      ['events', 'session_id'],
      ['sessions', 'id'],
      ['pages', 'session_id'],
      ['goals', 'session_id'],
    ] as const) {
      const total = await count(demoCh, table, '1');
      const tagged = await count(demoCh, table, `startsWith(${col}, 'vrddemo_')`);
      expect(tagged).toBe(total);
      expect(total).toBeGreaterThan(0);
    }

    // Every EVENT carries the _demo=1 property tag.
    const untagged = await count(
      demoCh,
      'events',
      `properties['_demo'] != '1'`,
    );
    expect(untagged).toBe(0);

    // VoIP sessions use vrddemo_voip_… NOT the real `voip:` prefix.
    const voipSessions = await count(
      demoCh,
      'goals',
      `goal_name = 'phone_call' AND startsWith(session_id, 'vrddemo_voip_')`,
    );
    expect(voipSessions).toBe(30);
    const realVoipPrefix = await count(demoCh, 'goals', `startsWith(session_id, 'voip:')`);
    expect(realVoipPrefix).toBe(0);

    // status reflects is_demo + mock counts.
    const st = await auth(
      request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.status`),
    )
      .send({ workspace_id: DEMO_WS })
      .expect(200);
    expect(st.body.is_demo).toBe(true);
    expect(st.body.mock_rows.events).toBeGreaterThan(0);
    expect(st.body.real_rows.events).toBe(0);
  }, 60_000);

  it('THE TTL SCENARIO: wipes vrddemo_ sessions/goals even when their events are gone', async () => {
    await insertWorkspaceRow(ctx.systemClient, DEMO_WS, 'https://client-demo.fr');

    // Simulate the state AFTER the events TTL (7d) purged the demo events:
    // sessions + goals rows still exist, but NO events back them.
    // We insert them directly, vrddemo_-prefixed, with an OLD timestamp.
    const oldTs = toClickHouseDateTime(new Date(Date.now() - 30 * 86_400_000));
    const sessionRows = Array.from({ length: 50 }, (_, i) => ({
      id: `vrddemo_ttl_s${i}`,
      workspace_id: DEMO_WS,
      created_at: oldTs,
      updated_at: oldTs,
      landing_page: 'https://client-demo.fr/',
      is_direct: true,
      year: 2026,
      month: 5,
      day: 1,
      day_of_week: 1,
      week_number: 22,
      hour: 10,
      is_weekend: false,
    }));
    await demoCh.insert({ table: 'sessions', values: sessionRows, format: 'JSONEachRow' });

    const goalRows = Array.from({ length: 20 }, (_, i) => ({
      session_id: `vrddemo_ttl_s${i}`,
      workspace_id: DEMO_WS,
      goal_name: 'phone_call',
      goal_value: 120,
      goal_timestamp: oldTs,
      path: '/voip',
      landing_page: 'https://client-demo.fr/',
      year: 2026,
      month: 5,
      day: 1,
      day_of_week: 1,
      week_number: 22,
      hour: 10,
      is_weekend: false,
    }));
    await demoCh.insert({ table: 'goals', values: goalRows, format: 'JSONEachRow' });

    // Sanity: events table is EMPTY (TTL purged), but sessions/goals are NOT.
    expect(await count(demoCh, 'events', '1')).toBe(0);
    expect(await count(demoCh, 'sessions', `startsWith(id, 'vrddemo_')`)).toBe(50);
    expect(await count(demoCh, 'goals', `startsWith(session_id, 'vrddemo_')`)).toBe(20);

    const res = await auth(
      request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.wipe`),
    )
      .send({ workspace_id: DEMO_WS })
      .expect(200);

    expect(res.body.is_demo).toBe(false);
    expect(res.body.deleted.sessions).toBe(50);
    expect(res.body.deleted.goals).toBe(20);
    expect(res.body.noop).toBe(false);

    // The orphan sessions/goals are GONE — proving wipe-by-session_id-prefix
    // works WITHOUT any events present (the tag-properties-only approach,
    // which can't reach sessions and would have lost the events to TTL, fails
    // exactly here).
    expect(await count(demoCh, 'sessions', `startsWith(id, 'vrddemo_')`)).toBe(0);
    expect(await count(demoCh, 'goals', `startsWith(session_id, 'vrddemo_')`)).toBe(0);
  }, 60_000);

  it('SABOTAGE: wipe preserves real data byte-for-byte (preserved_real.intact)', async () => {
    await insertWorkspaceRow(ctx.systemClient, REAL_WS, 'https://real-client.fr');

    // ── REAL data: native-shaped rows that must SURVIVE the wipe. ──────────
    const now = toClickHouseDateTime();
    const realSessions = Array.from({ length: 12 }, (_, i) => ({
      id: `real-session-${i}`, // NOT vrddemo_-prefixed
      workspace_id: REAL_WS,
      created_at: now,
      updated_at: now,
      landing_page: 'https://real-client.fr/',
      is_direct: false,
      year: 2026,
      month: 6,
      day: 27,
      day_of_week: 6,
      week_number: 26,
      hour: 14,
      is_weekend: true,
    }));
    await realCh.insert({ table: 'sessions', values: realSessions, format: 'JSONEachRow' });

    const realGoals = Array.from({ length: 5 }, (_, i) => ({
      session_id: `real-session-${i}`,
      workspace_id: REAL_WS,
      goal_name: 'purchase',
      goal_value: 99,
      goal_timestamp: now,
      path: '/checkout',
      landing_page: 'https://real-client.fr/',
      year: 2026,
      month: 6,
      day: 27,
      day_of_week: 6,
      week_number: 26,
      hour: 14,
      is_weekend: true,
    }));
    await realCh.insert({ table: 'goals', values: realGoals, format: 'JSONEachRow' });

    const realEvents = Array.from({ length: 8 }, (_, i) => ({
      session_id: `real-session-${i}`,
      workspace_id: REAL_WS,
      received_at: now,
      created_at: now,
      updated_at: now,
      name: 'screen_view',
      path: '/',
      landing_page: 'https://real-client.fr/',
      entered_at: now,
      exited_at: now,
      dedup_token: `real-session-${i}_pv_1`,
    }));
    await realCh.insert({ table: 'events', values: realEvents, format: 'JSONEachRow' });

    const realBefore = {
      events: await count(realCh, 'events', `NOT startsWith(session_id, 'vrddemo_')`),
      sessions: await count(realCh, 'sessions', `NOT startsWith(id, 'vrddemo_')`),
      goals: await count(realCh, 'goals', `NOT startsWith(session_id, 'vrddemo_')`),
    };
    expect(realBefore.events).toBe(8);
    expect(realBefore.sessions).toBe(12);
    expect(realBefore.goals).toBe(5);

    // ── Now seed demo data ON TOP, forcing past the real-data guard. ──────
    await auth(request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.seed`))
      .send({ workspace_id: REAL_WS, session_count: 300, voip_count: 20, days_range: 15, force: true })
      .expect(200);

    // ── Wipe — the destructive op. Real data MUST be untouched. ───────────
    const res = await auth(
      request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.wipe`),
    )
      .send({ workspace_id: REAL_WS })
      .expect(200);

    expect(res.body.noop).toBe(false);
    expect(res.body.preserved_real.intact).toBe(true);
    expect(res.body.preserved_real.before).toEqual(res.body.preserved_real.after);
    // The audited preserved_real counts match what we inserted.
    expect(res.body.preserved_real.after.events).toBe(8);
    expect(res.body.preserved_real.after.sessions).toBe(12);
    expect(res.body.preserved_real.after.goals).toBe(5);

    // Independent verification straight from ClickHouse: real rows intact,
    // ALL demo rows gone.
    expect(await count(realCh, 'events', `NOT startsWith(session_id, 'vrddemo_')`)).toBe(8);
    expect(await count(realCh, 'sessions', `NOT startsWith(id, 'vrddemo_')`)).toBe(12);
    expect(await count(realCh, 'goals', `NOT startsWith(session_id, 'vrddemo_')`)).toBe(5);
    expect(await count(realCh, 'events', `startsWith(session_id, 'vrddemo_')`)).toBe(0);
    expect(await count(realCh, 'sessions', `startsWith(id, 'vrddemo_')`)).toBe(0);
    expect(await count(realCh, 'goals', `startsWith(session_id, 'vrddemo_')`)).toBe(0);
  }, 90_000);

  it('seed refuses 409 DEMO_REAL_DATA_PRESENT over real data without force', async () => {
    await insertWorkspaceRow(ctx.systemClient, REAL_WS, 'https://real-client.fr');
    const now = toClickHouseDateTime();
    await realCh.insert({
      table: 'events',
      values: [
        {
          session_id: 'real-x',
          workspace_id: REAL_WS,
          received_at: now,
          created_at: now,
          updated_at: now,
          name: 'screen_view',
          path: '/',
          landing_page: 'https://real-client.fr/',
          entered_at: now,
          exited_at: now,
          dedup_token: 'real-x_pv_1',
        },
      ],
      format: 'JSONEachRow',
    });

    const res = await auth(request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.seed`))
      .send({ workspace_id: REAL_WS })
      .expect(409);
    expect(res.body.code).toBe('DEMO_REAL_DATA_PRESENT');
    // Canonical M2M error contract present.
    expect(res.body.statusCode).toBe(409);

    // force:true bypasses the guard.
    await auth(request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.seed`))
      .send({ workspace_id: REAL_WS, session_count: 50, voip_count: 5, force: true })
      .expect(200);
  }, 60_000);

  it('wipe on a workspace with no demo data is a clean no-op', async () => {
    await insertWorkspaceRow(ctx.systemClient, DEMO_WS, 'https://client-demo.fr');
    const res = await auth(request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.wipe`))
      .send({ workspace_id: DEMO_WS })
      .expect(200);
    expect(res.body.noop).toBe(true);
    expect(res.body.is_demo).toBe(false);
    expect(res.body.deleted).toEqual({ events: 0, sessions: 0, pages: 0, goals: 0 });
    expect(res.body.preserved_real.intact).toBe(true);
  }, 30_000);

  it('unknown workspace → 404 workspace_not_found', async () => {
    const res = await auth(request(ctx.app.getHttpServer()).post(`${ADMIN}/demo.status`))
      .send({ workspace_id: 'does_not_exist_ws' })
      .expect(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  }, 30_000);
});
