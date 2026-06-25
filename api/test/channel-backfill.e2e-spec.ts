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
import { ChannelBackfillService } from '../src/filters/backfill/channel-backfill.service';

const testWorkspaceId = 'channel_backfill_ws';

/**
 * Ticket 2026-06-24-channel-group-vide-sessions-historiques.
 *
 * Le canal est figé à l'ingestion par deriveChannel(). Les lignes ingérées
 * AVANT le chantier S1 ont channel/channel_group vides en base (les MV ne
 * rejouent jamais le passé). Le ChannelBackfillService re-dérive l'historique
 * avec la MÊME fonction pure deriveChannel() (pas de SQL parallèle).
 *
 * Ce spec tape le VRAI ClickHouse et le VRAI service. Il prouve :
 *  - une session utm_medium=email à channel_group='' passe à 'email' ;
 *  - un referrer non classé (mail.example.com) → 'referral' ;
 *  - aucun signal → 'direct' ;
 *  - les totaux sont conservés (rien inséré/supprimé) ;
 *  - idempotence : un 2e run ne change plus rien ;
 *  - sabotage : sans backfill, le channel reste vide.
 */
describe('ChannelBackfillService (E2E real ClickHouse)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let service: ChannelBackfillService;
  const workspaceId = testWorkspaceId;
  const baseDate = new Date('2026-06-10T10:00:00.000Z');

  function sessionRow(
    i: number,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    d.setUTCMinutes(d.getUTCMinutes() + i);
    return {
      id: `chbf-sess-${i}`,
      workspace_id: workspaceId,
      created_at: toClickHouseDateTime(d),
      updated_at: toClickHouseDateTime(d),
      is_direct: true,
      landing_page: 'https://test.com/',
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      day_of_week: d.getUTCDay() || 7,
      week_number: 1,
      hour: d.getUTCHours(),
      is_weekend: false,
      // Channel columns START EMPTY (the historical defect).
      channel: '',
      channel_group: '',
      // Signals (default: none → direct).
      utm_source: '',
      utm_medium: '',
      utm_id_from: '',
      referrer: '',
      referrer_domain: '',
      ...overrides,
    };
  }

  function goalRow(
    i: number,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    d.setUTCMinutes(d.getUTCMinutes() + i);
    return {
      id: `00000000-0000-0003-0000-0000000000${i.toString().padStart(2, '0')}`,
      session_id: `chbf-sess-${i}`,
      workspace_id: workspaceId,
      goal_name: 'signup',
      goal_value: 0,
      goal_timestamp: toClickHouseDateTime(d),
      path: '/signup',
      landing_page: 'https://test.com/',
      is_direct: true,
      channel: '',
      channel_group: '',
      utm_source: '',
      utm_medium: '',
      utm_id_from: '',
      referrer: '',
      referrer_domain: '',
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

  // Seed: 3 sessions/goals with distinct signal tuples, all channel_group=''.
  //   0: no signal           → direct
  //   1: utm_medium=email     → email   (the proven-inconsistent case)
  //   2: referrer mail.example.com (unclassified) → referral
  async function seed() {
    await truncateWorkspaceTables(workspaceClient, ['sessions', 'goals'], 0);
    const sessions = [
      sessionRow(0, {}),
      sessionRow(1, { utm_medium: 'email', utm_source: 'cold-email' }),
      sessionRow(2, {
        is_direct: false,
        referrer: 'https://mail.example.com/',
        referrer_domain: 'mail.example.com',
      }),
    ];
    const goals = [
      goalRow(0, {}),
      goalRow(1, { utm_medium: 'email', utm_source: 'cold-email' }),
      goalRow(2, {
        is_direct: false,
        referrer: 'https://mail.example.com/',
        referrer_domain: 'mail.example.com',
      }),
    ];
    await workspaceClient.insert({
      table: 'sessions',
      values: sessions,
      format: 'JSONEachRow',
    });
    await workspaceClient.insert({
      table: 'goals',
      values: goals,
      format: 'JSONEachRow',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE sessions FINAL' });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE goals FINAL' });
    await waitForClickHouse();
  }

  // Channel distribution by DISTINCT row identity. Both sessions and goals are
  // ReplacingMergeTree; an ALTER UPDATE mutation can transiently leave the
  // pre-mutation and post-mutation parts active until the background merge runs,
  // so a plain `count()` may momentarily see both versions of a row. We dedup by
  // the row's primary identity (sessions.id / goals.id) via uniqExact — exactly
  // how the production analytics layer counts sessions (uniqExact(id) on
  // `sessions FINAL`, cf query-builder.ts) — so the assertion is deterministic.
  async function channelDist(
    table: 'sessions' | 'goals',
  ): Promise<Record<string, number>> {
    const dbName = `staminads_ws_${workspaceId}`;
    const r = await workspaceClient.query({
      query: `SELECT channel_group, uniqExact(id) AS c
              FROM ${dbName}.${table} FINAL
              GROUP BY channel_group`,
      format: 'JSONEachRow',
    });
    const rows = (await r.json()) as Array<{
      channel_group: string;
      c: string;
    }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.channel_group] = Number(row.c);
    return out;
  }

  /**
   * Make post-backfill reads deterministic.
   *
   * The backfill rewrites channel_group via `ALTER TABLE ... UPDATE` — a
   * ClickHouse MUTATION, which is a distinct mechanism from a ReplacingMergeTree
   * merge. `OPTIMIZE ... FINAL` only forces the merge; it does NOT force a
   * pending mutation to finish. Until the mutation is done, the pre-mutation
   * part (channel_group='') and the post-mutation part (channel_group='email')
   * can both be active for the same row id. A `GROUP BY channel_group` then sees
   * the same id in two buckets → the count is inflated (3 instead of 1).
   *
   * So we POLL system.mutations until is_done=1 for this workspace DB BEFORE we
   * OPTIMIZE FINAL and read. This — not the OPTIMIZE — is what makes the
   * assertions deterministic: drop the waitForMutations call and the
   * channel-distribution reads go flaky/red again.
   */
  async function settle() {
    const dbName = `staminads_ws_${workspaceId}`;
    await waitForMutations(workspaceClient, dbName, {
      timeoutMs: 60000,
      intervalMs: 500,
      onTimeout: 'throw',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE sessions FINAL' });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE goals FINAL' });
    await waitForClickHouse();
  }

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;
    service = ctx.moduleFixture.get(ChannelBackfillService);

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await createTestWorkspace(systemClient, workspaceId, {
      name: 'Channel Backfill Workspace',
      website: 'https://test.com',
    });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('SABOTAGE: without backfill, channel_group stays empty (the bug)', async () => {
    await seed();
    const before = await channelDist('sessions');
    // All 3 seeded sessions are still channel_group='' — the defect.
    expect(before['']).toBe(3);
    expect(before['email']).toBeUndefined();
    expect(before['referral']).toBeUndefined();
  });

  it('re-derives channel/channel_group on historical sessions + goals', async () => {
    await seed();
    const summary = await service.backfillChannel(workspaceId);
    await settle();

    // 3 sessions + 3 goals all moved off the empty bucket.
    expect(summary.sessions_updated).toBe(3);
    expect(summary.goals_updated).toBe(3);

    const sess = await channelDist('sessions');
    expect(sess['']).toBeUndefined(); // no empty channel left
    expect(sess['direct']).toBe(1);
    expect(sess['email']).toBe(1); // utm_medium=email correctly classified
    expect(sess['referral']).toBe(1);

    const goals = await channelDist('goals');
    expect(goals['']).toBeUndefined();
    expect(goals['direct']).toBe(1);
    expect(goals['email']).toBe(1);
    expect(goals['referral']).toBe(1);
  });

  it('preserves totals (only channel columns rewritten, no row added/removed)', async () => {
    await seed();
    const dbName = `staminads_ws_${workspaceId}`;
    // uniqExact(id) on FINAL = deterministic session total (cf channelDist).
    const totalQuery = async () => {
      const r = await workspaceClient.query({
        query: `SELECT uniqExact(id) AS c FROM ${dbName}.sessions FINAL`,
        format: 'JSONEachRow',
      });
      const rows = (await r.json()) as Array<{ c: string }>;
      return Number(rows[0].c);
    };

    const totalBefore = await totalQuery();
    await service.backfillChannel(workspaceId);
    await settle();
    const totalAfter = await totalQuery();

    // Only channel columns rewritten → row count invariant.
    expect(totalAfter).toBe(totalBefore);

    // Sum across channel groups == total sessions (no row lost to a bad bucket).
    const dist = await channelDist('sessions');
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    expect(sum).toBe(totalAfter);
  });

  it('is idempotent: a second run updates 0 rows', async () => {
    await seed();
    const first = await service.backfillChannel(workspaceId);
    expect(first.sessions_updated).toBe(3);
    expect(first.goals_updated).toBe(3);

    const second = await service.backfillChannel(workspaceId);
    expect(second.sessions_updated).toBe(0);
    expect(second.goals_updated).toBe(0);
    expect(second.changes.length).toBe(0);
    await settle();

    // Distribution unchanged after the second run.
    const sess = await channelDist('sessions');
    expect(sess['direct']).toBe(1);
    expect(sess['email']).toBe(1);
    expect(sess['referral']).toBe(1);
  });
});
