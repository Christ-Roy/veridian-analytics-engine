// Set env vars BEFORE any imports so ConfigModule picks them up.
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
  TestAppContext,
} from './helpers';

const WS = 'tunnel_test_ws';

interface SeedEvent {
  session_id: string;
  user_id: string;
  name: 'screen_view' | 'goal';
  path?: string;
  max_scroll?: number;
  goal_name?: string;
  properties?: Record<string, string>;
  at: string; // ISO
}

describe('Tunnel aggregate E2E', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let authToken: string;

  const now = new Date();
  const iso = (offsetMin: number) =>
    new Date(now.getTime() - offsetMin * 60_000).toISOString();

  async function seed(events: SeedEvent[]): Promise<void> {
    const rows = events.map((e, i) => {
      const ch = toClickHouseDateTime(new Date(e.at));
      return {
        id: `00000000-0000-0aaa-0000-0000000000${i.toString().padStart(2, '0')}`,
        session_id: e.session_id,
        workspace_id: WS,
        received_at: ch,
        created_at: ch,
        updated_at: ch,
        name: e.name,
        path: e.path ?? '/',
        max_scroll: e.max_scroll ?? 0,
        page_number: 1,
        goal_name: e.goal_name ?? '',
        goal_value: 0,
        dedup_token: `${e.session_id}_${i}`,
        properties: e.properties ?? {},
        entered_at: ch,
        exited_at: ch,
        goal_timestamp: e.name === 'goal' ? ch : null,
        user_id: e.user_id,
        landing_page: '',
        _version: Date.now() + i,
      };
    });
    await workspaceClient.insert({ table: 'events', values: rows, format: 'JSONEachRow' });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE events FINAL' });
  }

  const fetchAggregate = (workspaceId: string, token = authToken) =>
    request(ctx.app.getHttpServer())
      .get('/api/tunnel.aggregate')
      .query({ workspace_id: workspaceId, since: iso(60 * 24) }) // last 24h
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: WS });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;

    await truncateSystemTables(systemClient, ['users'], 0);
    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await truncateWorkspaceTables(workspaceClient, ['events'], 0);

    const { token } = await createUserWithToken(
      ctx.app,
      systemClient,
      'tunnel-test@test.com',
      undefined,
      { name: 'Tunnel Test', isSuperAdmin: true },
    );
    authToken = token;
    await createTestWorkspace(systemClient, WS, { name: 'Tunnel WS', website: 'https://test.com' });
  }, 60_000);

  afterAll(async () => {
    await truncateWorkspaceTables(workspaceClient, ['events'], 0);
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncateWorkspaceTables(workspaceClient, ['events'], 0);
  });

  it('requires a Bearer token (401 without)', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/tunnel.aggregate')
      .query({ workspace_id: WS, since: iso(60) });
    expect(res.status).toBe(401);
  });

  it('returns the full AnalyticsAggregate shape per identity', async () => {
    await seed([
      { session_id: 's1', user_id: 'lead@x.com', name: 'screen_view', path: '/audit/abc', max_scroll: 90, at: iso(30) },
      { session_id: 's1', user_id: 'lead@x.com', name: 'goal', goal_name: 'audit_cta_rdv', at: iso(28) },
      { session_id: 's2', user_id: 'lead@x.com', name: 'screen_view', path: '/tarifs', at: iso(20) },
      { session_id: 's2', user_id: 'lead@x.com', name: 'goal', goal_name: 'rdv_booked', at: iso(18) },
    ]);

    const res = await fetchAggregate(WS);
    expect(res.status).toBe(200);
    expect(res.body.workspace_id).toBe(WS);
    expect(res.body.window).toHaveProperty('since');
    expect(res.body.window).toHaveProperty('until');

    const agg = res.body.aggregates.find((a: { userId: string }) => a.userId === 'lead@x.com');
    expect(agg).toBeDefined();
    // full contract shape present
    expect(agg).toEqual(
      expect.objectContaining({
        userId: 'lead@x.com',
        auditViews: 1,
        auditScrollMax: 90,
        hotPages: 1, // /tarifs
        otherPages: 0,
        ctaClicks: 1,
        rdvBooked: 1,
        identifiedByEmail: true,
        appStarted: false,
        sessions: 2,
      }),
    );
    expect(agg).toHaveProperty('consented');
    expect(agg).toHaveProperty('lastSeen');
  });

  it('aggregates a slug identity separately (bridge unions slug↔email)', async () => {
    await seed([
      { session_id: 's3', user_id: 'monsite-ab3x', name: 'screen_view', path: '/audit/monsite', max_scroll: 80, at: iso(15) },
    ]);
    const res = await fetchAggregate(WS);
    const agg = res.body.aggregates.find((a: { userId: string }) => a.userId === 'monsite-ab3x');
    expect(agg).toMatchObject({ userId: 'monsite-ab3x', auditViews: 1, auditScrollMax: 80, identifiedByEmail: false });
  });

  it('is multi-tenant: another workspace sees none of WS data', async () => {
    await seed([
      { session_id: 's4', user_id: 'private@x.com', name: 'goal', goal_name: 'rdv_booked', at: iso(10) },
    ]);
    // A second workspace the same super-admin owns but with no events.
    const OTHER = 'tunnel_other_ws';
    await createTestWorkspace(systemClient, OTHER, { name: 'Other WS', website: 'https://other.com' });
    const res = await fetchAggregate(OTHER);
    expect(res.status).toBe(200);
    expect(
      res.body.aggregates.find((a: { userId: string }) => a.userId === 'private@x.com'),
    ).toBeUndefined();
  });
});
