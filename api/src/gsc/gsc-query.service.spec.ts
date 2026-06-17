import { GscQueryService } from './gsc-query.service';
import { ClickHouseService } from '../database/clickhouse.service';
import { GscRepository } from './gsc.repository';
import { GscProperty } from './entities/gsc-property.entity';

function makeProperty(over: Partial<GscProperty> = {}): GscProperty {
  return {
    id: 'gsc_1',
    workspace_id: 'ws_1',
    site_url: 'sc-domain:exemple.fr',
    ownership_state: 'verified',
    oauth_tokens_encrypted: 'enc',
    last_sync_at: null,
    created_at: '2026-01-01 00:00:00.000',
    updated_at: '2026-01-01 00:00:00.000',
    deleted_at: null,
    ...over,
  };
}

/**
 * Stub ClickHouse qui route les SELECT vers une réponse par "forme" de requête :
 * - GROUP BY query  → topQueries
 * - GROUP BY page   → topPages
 * - date ASC        → timeseries
 * - sinon           → totals
 */
function makeClickhouse(rows: {
  totals?: unknown[];
  query?: unknown[];
  page?: unknown[];
  date?: unknown[];
}): ClickHouseService {
  return {
    querySystem: jest.fn(async (sql: string) => {
      if (/GROUP BY k[\s\S]*ORDER BY k ASC/.test(sql)) return rows.date ?? [];
      if (/query AS k/.test(sql)) return rows.query ?? [];
      if (/page AS k/.test(sql)) return rows.page ?? [];
      return rows.totals ?? [];
    }),
  } as unknown as ClickHouseService;
}

function makeRepo(prop: GscProperty | null): GscRepository {
  return {
    findPropertyByWorkspace: jest.fn(async () => prop),
  } as unknown as GscRepository;
}

describe('GscQueryService', () => {
  it('returns property:null when workspace has no verified property', async () => {
    const svc = new GscQueryService(makeClickhouse({}), makeRepo(null));
    const r = await svc.dashboardSummary({ workspaceId: 'ws_1', days: 28 });
    expect(r.property).toBeNull();
    expect(r.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
    expect(r.topQueries).toEqual([]);
  });

  it('computes CTR from aggregated totals (not naive average)', async () => {
    const ch = makeClickhouse({
      totals: [{ clicks: 50, impressions: 1000, position: 4.2 }],
      query: [],
      page: [],
      date: [],
    });
    const svc = new GscQueryService(ch, makeRepo(makeProperty()));
    const r = await svc.dashboardSummary({ workspaceId: 'ws_1', days: 28 });
    expect(r.property).toEqual({ id: 'gsc_1', siteUrl: 'sc-domain:exemple.fr' });
    expect(r.totals.clicks).toBe(50);
    expect(r.totals.impressions).toBe(1000);
    expect(r.totals.ctr).toBeCloseTo(0.05, 6);
    expect(r.totals.position).toBeCloseTo(4.2, 6);
  });

  it('shapes topQueries / topPages / timeseries rows with keys[]', async () => {
    const ch = makeClickhouse({
      totals: [{ clicks: 10, impressions: 100, position: 3 }],
      query: [
        { k: 'plombier paris', clicks: 8, impressions: 80, position: 2 },
        { k: 'plombier 75', clicks: 2, impressions: 20, position: 5 },
      ],
      page: [{ k: 'https://exemple.fr/contact', clicks: 6, impressions: 50, position: 1.5 }],
      date: [
        { k: '2026-06-01', clicks: 4, impressions: 40, position: 3 },
        { k: '2026-06-02', clicks: 6, impressions: 60, position: 2.5 },
      ],
    });
    const svc = new GscQueryService(ch, makeRepo(makeProperty()));
    const r = await svc.dashboardSummary({ workspaceId: 'ws_1', days: 7 });

    expect(r.topQueries[0]).toEqual({
      keys: ['plombier paris'],
      clicks: 8,
      impressions: 80,
      ctr: 0.1,
      position: 2,
    });
    expect(r.topPages[0].keys).toEqual(['https://exemple.fr/contact']);
    expect(r.timeseries.map((t) => t.keys[0])).toEqual([
      '2026-06-01',
      '2026-06-02',
    ]);
  });

  it('treats a pending property as not connected', async () => {
    const svc = new GscQueryService(
      makeClickhouse({}),
      makeRepo(makeProperty({ ownership_state: 'pending', site_url: '' })),
    );
    const r = await svc.dashboardSummary({ workspaceId: 'ws_1', days: 28 });
    expect(r.property).toBeNull();
  });
});
