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
import { IdentityBackfillService } from '../src/filters/backfill/identity-backfill.service';
import { AdminPlatformService } from '../src/admin-platform/admin-platform.service';

const testWorkspaceId = 'identity_backfill_ws';

/**
 * S6 Lot C — IdentityBackfillService (re-stitch HISTORIQUE).
 *
 * IdentityStitchService (Lot A) ne se déclenche qu'au PREMIER event avec user_id
 * — donc seulement pour les inscrits qui se logguent APRÈS S6. Les inscrits qui
 * ont signé AVANT (Joséphine/Valentin/Michele sur Yoga Sculpt) n'ont jamais
 * stitché : leur user_attribution est vide, leurs sessions/goals ont
 * first_touch_* vide. Ce backfill rejoue le stitch sur TOUT l'historique.
 *
 * Ce spec tape le VRAI ClickHouse + le VRAI IdentityBackfillService (qui réutilise
 * le VRAI IdentityStitchService — zéro logique de matching dupliquée). Il prouve :
 *  - SABOTAGE : sans backfill, aucune provenance (signup paraît `direct`) ;
 *  - le backfill re-stitche N inscrits historiques en un call → user_attribution
 *    rempli + first_touch_* dénormalisé sur leurs sessions ;
 *  - la provenance (analytics.userProvenance) renvoie le bon channel par inscrit ;
 *  - le cas REFERRAL (?ref=) : la provenance porte le bon referral_code SANS
 *    aucun filtre channel seedé sur le workspace → prouve que la provenance
 *    by-passe la taxonomie de filtres (vit dans user_attribution) ;
 *  - idempotence : un 2e backfill ne change rien + total-preserving (zéro row
 *    ajoutée/supprimée sur sessions).
 */
describe('IdentityBackfillService (E2E real ClickHouse, S6 Lot C)', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let workspaceClient: ClickHouseClient;
  let service: IdentityBackfillService;
  let adminPlatform: AdminPlatformService;
  const workspaceId = testWorkspaceId;
  const dbName = `staminads_ws_${workspaceId}`;
  const baseDate = new Date('2026-06-20T10:00:00.000Z');

  function sessionRow(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const d = new Date(baseDate);
    return {
      id: 'bf-sess-default',
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

  /**
   * Seed ONE historical user's vitrine→app chain (linked by fingerprint, the
   * only key that works in current prod data). The vitrine session carries the
   * REAL acquisition; the app /login session is direct + carries the user_id.
   * `i` keeps ids/fingerprints unique across users.
   */
  function chainRows(opts: {
    i: number;
    email: string;
    vitrineChannel: string;
    vitrineChannelGroup: string;
    vitrineLanding?: string;
    referralCode?: string;
    minutesGap?: number;
  }): Record<string, unknown>[] {
    const fp = `fp_user_${opts.i}`;
    const vitrineTime = new Date(baseDate);
    vitrineTime.setUTCMinutes(vitrineTime.getUTCMinutes() + opts.i * 10);
    const appTime = new Date(vitrineTime);
    appTime.setUTCMinutes(appTime.getUTCMinutes() + (opts.minutesGap ?? 1));

    const vitrine = sessionRow({
      id: `vitrine-${opts.i}`,
      created_at: toClickHouseDateTime(vitrineTime),
      updated_at: toClickHouseDateTime(vitrineTime),
      landing_page: opts.vitrineLanding ?? 'https://test.com/',
      landing_domain: 'test.com',
      is_direct: opts.vitrineChannelGroup === 'referral',
      referrer:
        opts.vitrineChannelGroup === 'referral' ? '' : 'https://www.google.com/',
      referrer_domain:
        opts.vitrineChannelGroup === 'referral' ? '' : 'www.google.com',
      channel: opts.vitrineChannel,
      channel_group: opts.vitrineChannelGroup,
      // For referral, the parrain code lives in utm_content (Lot B contract).
      utm_content: opts.referralCode ?? '',
      user_id: null,
      visitor_id: `vitrine-vid-${opts.i}`,
      fingerprint: fp,
    });

    const app = sessionRow({
      id: `app-${opts.i}`,
      created_at: toClickHouseDateTime(appTime),
      updated_at: toClickHouseDateTime(appTime),
      channel: 'direct',
      channel_group: 'direct',
      user_id: opts.email,
      visitor_id: `app-vid-${opts.i}`,
      fingerprint: fp,
    });

    return [vitrine, app];
  }

  async function seedHistory() {
    await truncateWorkspaceTables(workspaceClient, ['sessions'], 0);
    const rows = [
      // Joséphine — came from Google Ads (paid_search).
      ...chainRows({
        i: 1,
        email: 'josephine@test.com',
        vitrineChannel: 'paid_search',
        vitrineChannelGroup: 'ads',
      }),
      // Michele — came from organic search (seo).
      ...chainRows({
        i: 2,
        email: 'michele@test.com',
        vitrineChannel: 'organic_search',
        vitrineChannelGroup: 'seo',
      }),
      // Valentin — came from a referral (?ref=VHCRPP6X parrainage).
      ...chainRows({
        i: 3,
        email: 'valentin@test.com',
        vitrineChannel: 'referral',
        vitrineChannelGroup: 'referral',
        vitrineLanding: 'https://test.com/?ref=VHCRPP6X',
        referralCode: 'VHCRPP6X',
      }),
    ];
    await workspaceClient.insert({
      table: 'sessions',
      values: rows,
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

  async function attributionCount(): Promise<number> {
    const r = await workspaceClient.query({
      query: `SELECT count() AS c FROM ${dbName}.user_attribution FINAL`,
      format: 'JSONEachRow',
    });
    const rows = (await r.json()) as Array<{ c: string }>;
    return Number(rows[0].c);
  }

  async function sessionTotal(): Promise<number> {
    const r = await workspaceClient.query({
      query: `SELECT uniqExact(id) AS c FROM ${dbName}.sessions FINAL`,
      format: 'JSONEachRow',
    });
    const rows = (await r.json()) as Array<{ c: string }>;
    return Number(rows[0].c);
  }

  async function sessionFirstTouch(email: string): Promise<string[]> {
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

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    workspaceClient = ctx.workspaceClient!;
    service = ctx.moduleFixture.get(IdentityBackfillService);
    adminPlatform = ctx.moduleFixture.get(AdminPlatformService);

    await truncateSystemTables(systemClient, ['workspaces'], 0);
    await createTestWorkspace(systemClient, workspaceId, {
      name: 'Identity Backfill Workspace',
      website: 'https://app.test.com',
    });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('SABOTAGE: without backfill, the historical signups have no provenance', async () => {
    await seedHistory();

    // No user_attribution rows; the identified sessions read first_touch=''.
    expect(await attributionCount()).toBe(0);
    expect(await sessionFirstTouch('josephine@test.com')).toEqual(['']);

    // The provenance endpoint returns an empty list (nothing stitched yet).
    const prov = await adminPlatform.userProvenance({ workspace_id: workspaceId });
    expect(prov.count).toBe(0);
    expect(prov.users).toEqual([]);
  });

  it('re-stitches every historical signup in one call (user_attribution + denormalize)', async () => {
    await seedHistory();

    const summary = await service.backfillIdentity(workspaceId);
    await settle();

    // 3 historical users found, all 3 recoverable (each has a richer vitrine).
    expect(summary.users_scanned).toBe(3);
    expect(summary.users_stitched).toBe(3);
    expect(summary.users_unresolved).toBe(0);
    // All linked via the fingerprint bridge (the prod-realistic key).
    expect(summary.by_method.fingerprint).toBe(3);

    // One canonical attribution row per user.
    expect(await attributionCount()).toBe(3);

    // first_touch denormalized onto each user's identified session.
    expect(await sessionFirstTouch('josephine@test.com')).toEqual(['ads']);
    expect(await sessionFirstTouch('michele@test.com')).toEqual(['seo']);
    expect(await sessionFirstTouch('valentin@test.com')).toEqual(['referral']);
  });

  it('provenance endpoint returns the right channel per signup', async () => {
    await seedHistory();
    await service.backfillIdentity(workspaceId);
    await settle();

    const prov = await adminPlatform.userProvenance({ workspace_id: workspaceId });
    expect(prov.count).toBe(3);

    const byUser = Object.fromEntries(prov.users.map((u) => [u.user_id, u]));

    // Joséphine — Google Ads (was wrongly `not-mapped`/`direct` before S6).
    expect(byUser['josephine@test.com'].first_touch_channel_group).toBe('ads');
    expect(byUser['josephine@test.com'].first_touch_method).toBe('fingerprint');
    // Last-touch = the /login session, legitimately direct.
    expect(byUser['josephine@test.com'].last_touch_channel_group).toBe('direct');

    // Michele — organic search.
    expect(byUser['michele@test.com'].first_touch_channel_group).toBe('seo');
  });

  it('REFERRAL provenance carries the parrain code WITHOUT any seeded channel filter', async () => {
    await seedHistory();
    await service.backfillIdentity(workspaceId);
    await settle();

    // Single-user query (the dto.user filter path).
    const prov = await adminPlatform.userProvenance({
      workspace_id: workspaceId,
      user: 'valentin@test.com',
    });
    expect(prov.count).toBe(1);
    const v = prov.users[0];

    // first_touch = referral, and the parrain code came through user_attribution
    // (seeded from utm_content by the stitch). This proves the provenance is
    // INDEPENDENT of the session-level channel taxonomy / referral filter 745:
    // no default filter is seeded on this test workspace, yet the provenance is
    // correct. (The session-level channel reconciliation is Lot B's concern.)
    expect(v.first_touch_channel_group).toBe('referral');
    expect(v.referral_code).toBe('VHCRPP6X');
    expect(v.first_touch_utm_content).toBe('VHCRPP6X');
  });

  it('is idempotent and total-preserving: a second backfill changes nothing', async () => {
    await seedHistory();

    const totalBefore = await sessionTotal();

    const first = await service.backfillIdentity(workspaceId);
    await settle();
    const second = await service.backfillIdentity(workspaceId);
    await settle();

    // Same users found and re-stitched; the attribution set is stable.
    expect(first.users_stitched).toBe(3);
    expect(second.users_stitched).toBe(3);
    expect(await attributionCount()).toBe(3);

    // Denormalized columns unchanged.
    expect(await sessionFirstTouch('josephine@test.com')).toEqual(['ads']);

    // No session row added/removed by the backfill.
    expect(await sessionTotal()).toBe(totalBefore);
  });

  it('counts unresolved users (direct-only chain invents no acquisition)', async () => {
    await truncateWorkspaceTables(workspaceClient, ['sessions'], 0);
    // One user whose only sessions are direct → nothing to recover.
    const rows = [
      ...chainRows({
        i: 9,
        email: 'directonly@test.com',
        vitrineChannel: 'direct',
        vitrineChannelGroup: 'direct',
      }),
    ];
    await workspaceClient.insert({
      table: 'sessions',
      values: rows,
      format: 'JSONEachRow',
    });
    await workspaceClient.command({ query: 'OPTIMIZE TABLE sessions FINAL' });
    await waitForClickHouse();

    const summary = await service.backfillIdentity(workspaceId);
    await settle();

    expect(summary.users_scanned).toBe(1);
    expect(summary.users_stitched).toBe(0);
    expect(summary.users_unresolved).toBe(1);
    // No attribution row fabricated.
    expect(await attributionCount()).toBe(0);
  });
});
