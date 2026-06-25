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

const testWorkspaceId = 'identity_stitch_ws';

/**
 * S6 identity stitching — first-touch acquisition for identified users.
 * Ticket 2026-06-25-attribution-inscrit-stitch-crossdomain-et-canal-referral (Lot A).
 *
 * This spec taps the REAL ClickHouse and the REAL IdentityStitchService. It
 * reproduces the proven-in-prod Yoga Sculpt scenario: a visitor arrives on the
 * vitrine via Google Ads (anonymous, channel_group=seo/ads), then lands on the
 * app and logs in (channel_group=direct, user_id=email). The two sessions are
 * linked ONLY by a shared fingerprint (session_id/visitor_id re-minted per
 * origin in current data). After the stitch, the user's first_touch_channel_group
 * must be the vitrine channel, NOT direct.
 *
 * It proves:
 *  - fingerprint bridge (the only one that works in current prod data) →
 *    first_touch = seo, method = fingerprint;
 *  - session_id and visitor_id bridges (work once the SDK propagates identity);
 *  - the canonical user_attribution row is written (first + last touch);
 *  - first_touch_* is denormalized onto the user's sessions (native dimension);
 *  - SABOTAGE: without the stitch, first_touch stays empty; a direct-only chain
 *    yields no stitch (no false acquisition invented);
 *  - idempotence: a second stitch changes nothing;
 *  - total-preserving: no session row added/removed.
 */
describe('IdentityStitchService (E2E real ClickHouse)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let service: IdentityStitchService;
  const workspaceId = testWorkspaceId;
  const dbName = `staminads_ws_${workspaceId}`;
  const baseDate = new Date('2026-06-25T10:00:00.000Z');

  function sessionRow(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    return {
      id: 'stitch-sess-default',
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

  /** Seed a vitrine→app chain linked by `bridge` (fingerprint|visitor_id|session_id). */
  async function seedChain(opts: {
    email: string;
    bridge: 'fingerprint' | 'visitor_id' | 'session_id';
    vitrineChannelGroup: string;
    vitrineChannel: string;
    minutesGap?: number;
  }) {
    await truncateWorkspaceTables(workspaceClient, ['sessions'], 0);

    const fp = opts.bridge === 'fingerprint' ? 'fp_shared_xyz' : '';
    const vid = opts.bridge === 'visitor_id' ? 'visitor_shared_123' : '';
    // For the session_id bridge, both rows share the same session id (the app
    // session adopts the vitrine session_id via _stm).
    const sharedSid = 'shared-stm-session-id';

    const vitrineTime = new Date(baseDate);
    const appTime = new Date(baseDate);
    appTime.setUTCMinutes(appTime.getUTCMinutes() + (opts.minutesGap ?? 1));

    // Anonymous vitrine session — carries the REAL acquisition channel.
    const vitrine = sessionRow({
      id: opts.bridge === 'session_id' ? sharedSid : 'vitrine-anon-sess',
      created_at: toClickHouseDateTime(vitrineTime),
      updated_at: toClickHouseDateTime(vitrineTime),
      landing_page: 'https://test.com/',
      landing_domain: 'test.com',
      is_direct: false,
      referrer: 'https://www.google.com/',
      referrer_domain: 'www.google.com',
      channel: opts.vitrineChannel,
      channel_group: opts.vitrineChannelGroup,
      user_id: null,
      visitor_id: opts.bridge === 'visitor_id' ? vid : 'vitrine-vid',
      fingerprint: fp || 'vitrine-fp',
    });

    // Identified app session (the /login session) — direct, carries the user_id.
    const app = sessionRow({
      id: opts.bridge === 'session_id' ? sharedSid : 'app-ident-sess',
      created_at: toClickHouseDateTime(appTime),
      updated_at: toClickHouseDateTime(appTime),
      channel: 'direct',
      channel_group: 'direct',
      user_id: opts.email,
      visitor_id: opts.bridge === 'visitor_id' ? vid : 'app-vid',
      fingerprint: fp || 'app-fp',
    });

    await workspaceClient.insert({
      table: 'sessions',
      values: [vitrine, app],
      format: 'JSONEachRow',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE sessions FINAL' });
    await waitForClickHouse();
  }

  async function settle() {
    await waitForMutations(workspaceClient, dbName, {
      timeoutMs: 60000,
      intervalMs: 500,
      onTimeout: 'throw',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE sessions FINAL' });
    await waitForClickHouse();
  }

  async function readAttribution(
    email: string,
  ): Promise<Record<string, string> | null> {
    const r = await workspaceClient.query({
      query: `SELECT * FROM ${dbName}.user_attribution FINAL
              WHERE identity_key = {e:String}`,
      query_params: { e: email },
      format: 'JSONEachRow',
    });
    const rows = (await r.json()) as Array<Record<string, string>>;
    return rows[0] ?? null;
  }

  async function readSessionFirstTouch(email: string): Promise<string[]> {
    const r = await workspaceClient.query({
      query: `SELECT first_touch_channel_group AS g
              FROM ${dbName}.sessions FINAL
              WHERE user_id = {e:String}`,
      query_params: { e: email },
      format: 'JSONEachRow',
    });
    const rows = (await r.json()) as Array<{ g: string }>;
    return rows.map((x) => x.g);
  }

  async function sessionTotal(): Promise<number> {
    const r = await workspaceClient.query({
      query: `SELECT uniqExact(id) AS c FROM ${dbName}.sessions FINAL`,
      format: 'JSONEachRow',
    });
    const rows = (await r.json()) as Array<{ c: string }>;
    return Number(rows[0].c);
  }

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;
    service = ctx.moduleFixture.get(IdentityStitchService);

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await createTestWorkspace(systemClient, workspaceId, {
      name: 'Identity Stitch Workspace',
      website: 'https://app.test.com',
    });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('SABOTAGE: without the stitch, the user has no first-touch (signup looks direct)', async () => {
    const email = 'jo@test.com';
    await seedChain({
      email,
      bridge: 'fingerprint',
      vitrineChannel: 'organic_search',
      vitrineChannelGroup: 'seo',
    });

    // Before stitching: no user_attribution row, and the identified session's
    // first_touch_channel_group is empty — the acquisition is lost.
    expect(await readAttribution(email)).toBeNull();
    const before = await readSessionFirstTouch(email);
    expect(before).toEqual(['']);
  });

  it('FINGERPRINT bridge: the signup inherits the vitrine Google-Ads channel (Yoga Sculpt case)', async () => {
    const email = 'jo@test.com';
    await seedChain({
      email,
      bridge: 'fingerprint',
      vitrineChannel: 'organic_search',
      vitrineChannelGroup: 'seo',
    });

    const method = await service.stitch(workspaceId, email);
    await settle();

    // The only bridge that works in current prod data.
    expect(method).toBe('fingerprint');

    const attr = await readAttribution(email);
    expect(attr).not.toBeNull();
    expect(attr!.first_touch_channel_group).toBe('seo');
    expect(attr!.first_touch_channel).toBe('organic_search');
    expect(attr!.first_touch_method).toBe('fingerprint');
    // Last touch = the /login session (legitimately direct).
    expect(attr!.last_touch_channel_group).toBe('direct');

    // Denormalized onto the identified session → native first_touch dimension.
    const sess = await readSessionFirstTouch(email);
    expect(sess).toEqual(['seo']);
  });

  it('VISITOR_ID bridge: stitches via the stable cross-session identity', async () => {
    const email = 'vid@test.com';
    await seedChain({
      email,
      bridge: 'visitor_id',
      vitrineChannel: 'paid_search',
      vitrineChannelGroup: 'ads',
    });

    const method = await service.stitch(workspaceId, email);
    await settle();

    expect(method).toBe('visitor_id');
    const attr = await readAttribution(email);
    expect(attr!.first_touch_channel_group).toBe('ads');
    expect(attr!.first_touch_method).toBe('visitor_id');
    expect(await readSessionFirstTouch(email)).toEqual(['ads']);
  });

  it('SESSION_ID bridge: stitches via the _stm-adopted session id', async () => {
    const email = 'sid@test.com';
    await seedChain({
      email,
      bridge: 'session_id',
      vitrineChannel: 'organic_search',
      vitrineChannelGroup: 'seo',
    });

    const method = await service.stitch(workspaceId, email);
    await settle();

    expect(method).toBe('session_id');
    const attr = await readAttribution(email);
    expect(attr!.first_touch_channel_group).toBe('seo');
    expect(attr!.first_touch_method).toBe('session_id');
  });

  it('SABOTAGE: a direct-only chain invents NO acquisition (no stitch)', async () => {
    const email = 'direct@test.com';
    // Both vitrine and app sessions are direct → nothing to recover.
    await seedChain({
      email,
      bridge: 'fingerprint',
      vitrineChannel: 'direct',
      vitrineChannelGroup: 'direct',
    });

    const method = await service.stitch(workspaceId, email);
    await settle();

    expect(method).toBeNull();
    expect(await readAttribution(email)).toBeNull();
    // The session's first_touch stays empty — we do not fabricate `direct`.
    expect(await readSessionFirstTouch(email)).toEqual(['']);
  });

  it('is idempotent and total-preserving: a second stitch changes nothing', async () => {
    const email = 'idem@test.com';
    await seedChain({
      email,
      bridge: 'fingerprint',
      vitrineChannel: 'organic_search',
      vitrineChannelGroup: 'seo',
    });

    const totalBefore = await sessionTotal();

    const m1 = await service.stitch(workspaceId, email);
    await settle();
    const m2 = await service.stitch(workspaceId, email);
    await settle();

    expect(m1).toBe('fingerprint');
    expect(m2).toBe('fingerprint');

    // One canonical row, unchanged first-touch.
    const attr = await readAttribution(email);
    expect(attr!.first_touch_channel_group).toBe('seo');
    expect(await readSessionFirstTouch(email)).toEqual(['seo']);

    // No session row added/removed by the stitch.
    expect(await sessionTotal()).toBe(totalBefore);
  });
});
