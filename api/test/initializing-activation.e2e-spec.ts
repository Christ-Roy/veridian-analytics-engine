// Set env vars BEFORE any imports to ensure ConfigModule picks them up
import { setupTestEnv } from './constants/test-config';
setupTestEnv();

import { ClickHouseClient } from '@clickhouse/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { EventBufferService } from '../src/events/event-buffer.service';
import {
  createTestWorkspace,
  truncateSystemTables,
  truncateWorkspaceTables,
  createTestApp,
  closeTestApp,
  getService,
  waitForClickHouse,
  waitUntil,
  TestAppContext,
} from './helpers';

/**
 * P0 NON-REGRESSION GUARD (ticket 2026-06-24-P0-killswitch-initializing).
 *
 * The bug: a workspace is provisioned in status 'initializing' and NO code ever
 * flipped it to 'active'. A kill-switch `if (status !== 'active') drop` then
 * silently dropped 100 % of that workspace's real /api/track traffic, in a 200
 * mute, forever — and tracking.verify bypassed the door so it never noticed.
 *
 * These tests assert, through the REAL HTTP door, that:
 *   1. An 'initializing' workspace INGESTS its first event (no silent drop) and
 *      is flipped to 'active' by that first valid payload.
 *   2. The kill-switch STILL drops a genuinely 'inactive' workspace (we didn't
 *      open the gate wide; only 'inactive'/'error' are blocked).
 *
 * Test 1 is the guard whose ABSENCE let the kill-switch ship: if anyone recasts
 * the kill-switch to `status !== 'active'` again, test 1 goes red.
 */
const testWorkspaceId = 'test_ws_init_activate';

describe('P0: initializing → active transition + kill-switch scope (E2E)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let eventBuffer: EventBufferService;
  let eventEmitter: EventEmitter2;

  const createSessionPayload = (overrides: Record<string, unknown> = {}) => ({
    workspace_id: testWorkspaceId,
    session_id: `sess-${Date.now()}`,
    actions: [
      {
        type: 'pageview',
        path: '/home',
        page_number: 1,
        duration: 5000,
        scroll: 50,
        entered_at: Date.now() - 5000,
        exited_at: Date.now(),
      },
    ],
    attributes: { landing_page: 'https://example.com/home' },
    created_at: Date.now() - 10000,
    updated_at: Date.now(),
    ...overrides,
  });

  /** Read the freshest workspace status (ReplacingMergeTree → latest row). */
  async function readStatus(id: string): Promise<string | null> {
    const res = await systemClient.query({
      query: `SELECT status FROM workspaces
              WHERE id = {id:String}
              ORDER BY updated_at DESC LIMIT 1`,
      query_params: { id },
      format: 'JSONEachRow',
    });
    const rows = await res.json<{ status: string }>();
    return rows[0]?.status ?? null;
  }

  /** Count ingested events for a session (after flush). */
  async function countEvents(sessionId: string): Promise<number> {
    const res = await workspaceClient.query({
      query: `SELECT count() AS c FROM events WHERE session_id = {sid:String}`,
      query_params: { sid: sessionId },
      format: 'JSONEachRow',
    });
    const rows = await res.json<{ c: string }>();
    return Number(rows[0]?.c ?? 0);
  }

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;
    eventBuffer = getService(ctx, EventBufferService);
    eventEmitter = getService(ctx, EventEmitter2);
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
    ]);
    // The handler caches the workspace (status included) for 60s. Each test
    // recreates the SAME workspace id with a DIFFERENT status, so we bust the
    // handler cache between tests to read the freshest status, not a stale one.
    eventEmitter.emit('workspace.settings.changed', {
      workspaceId: testWorkspaceId,
    });
  });

  it('ingests the first event of an "initializing" workspace AND flips it to "active"', async () => {
    // Provisioned exactly like WorkspacesService.create does: status init.
    await createTestWorkspace(systemClient, testWorkspaceId, {
      status: 'initializing',
    });

    const sessionId = `sess-init-${Date.now()}`;
    const payload = createSessionPayload({ session_id: sessionId });

    const response = await request(ctx.app.getHttpServer())
      .post('/api/track')
      .send(payload)
      .expect(200);
    expect(response.body.success).toBe(true);

    // The event MUST land in ClickHouse (no silent kill-switch drop).
    await eventBuffer.flushAll();
    await waitForClickHouse();
    expect(await countEvents(sessionId)).toBeGreaterThan(0);

    // …and the first valid payload MUST flip the workspace to 'active'
    // (the transition the old comment promised but never implemented). The
    // flip is best-effort/async, so we poll the freshest status row.
    const becameActive = await waitUntil(
      async () => (await readStatus(testWorkspaceId)) === 'active',
      { timeoutMs: 8000, intervalMs: 150, onTimeout: 'warn' },
    );
    expect(becameActive).toBe(true);
    expect(await readStatus(testWorkspaceId)).toBe('active');
  });

  it('kill-switch STILL drops an "inactive" workspace (gate not opened wide)', async () => {
    await createTestWorkspace(systemClient, testWorkspaceId, {
      status: 'inactive',
    });

    const sessionId = `sess-inactive-${Date.now()}`;
    const payload = createSessionPayload({ session_id: sessionId });

    // The endpoint still answers 200 (mute, no tenant-state leak)…
    await request(ctx.app.getHttpServer())
      .post('/api/track')
      .send(payload)
      .expect(200);

    // …but the event is dropped: nothing stored, status untouched.
    await eventBuffer.flushAll();
    await waitForClickHouse();
    expect(await countEvents(sessionId)).toBe(0);
    expect(await readStatus(testWorkspaceId)).toBe('inactive');
  });

  it('keeps ingesting an already-"active" workspace (status stays active)', async () => {
    await createTestWorkspace(systemClient, testWorkspaceId, {
      status: 'active',
    });

    const sessionId = `sess-active-${Date.now()}`;
    const payload = createSessionPayload({ session_id: sessionId });

    await request(ctx.app.getHttpServer())
      .post('/api/track')
      .send(payload)
      .expect(200);

    await eventBuffer.flushAll();
    await waitForClickHouse();
    expect(await countEvents(sessionId)).toBeGreaterThan(0);
    expect(await readStatus(testWorkspaceId)).toBe('active');
  });
});
