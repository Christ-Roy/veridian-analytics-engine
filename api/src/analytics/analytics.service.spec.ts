import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AnalyticsService } from './analytics.service';
import { ClickHouseService } from '../database/clickhouse.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { Workspace } from '../workspaces/entities/workspace.entity';
import {
  FunnelResponse,
  FunnelSegmentedResponse,
} from './dto/funnel-query.dto';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let workspacesService: jest.Mocked<WorkspacesService>;
  let clickhouse: jest.Mocked<ClickHouseService>;
  let cacheManager: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };

  const mockWorkspace: Workspace = {
    id: 'ws-1',
    name: 'Test Workspace',
    website: 'https://example.com',
    timezone: 'UTC',
    currency: 'USD',
    status: 'active',
    created_at: '2025-01-01 00:00:00',
    updated_at: '2025-01-01 00:00:00',
    settings: {
      timescore_reference: 180,
      bounce_threshold: 10,
      custom_dimensions: {},
      filters: [],
      integrations: [],
      geo_enabled: true,
      geo_store_city: true,
      geo_store_region: true,
      geo_coordinates_precision: 2,
    },
  };

  const mockQueryResult = [
    { date_day: '2025-01-01', sessions: 100 },
    { date_day: '2025-01-02', sessions: 150 },
  ];

  beforeEach(async () => {
    cacheManager = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: ClickHouseService,
          useValue: {
            queryWorkspace: jest.fn().mockResolvedValue(mockQueryResult),
          },
        },
        {
          provide: WorkspacesService,
          useValue: {
            get: jest.fn().mockResolvedValue(mockWorkspace),
          },
        },
        {
          provide: CACHE_MANAGER,
          useValue: cacheManager,
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    workspacesService = module.get(WorkspacesService);
    clickhouse = module.get(ClickHouseService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('query caching', () => {
    const baseQuery = {
      workspace_id: 'ws-1',
      metrics: ['sessions'],
      dateRange: {
        start: '2025-01-01 00:00:00',
        end: '2025-01-02 23:59:59',
        granularity: 'day' as const,
      },
    };

    it('returns cached result on cache hit', async () => {
      const cachedResult = {
        data: mockQueryResult,
        meta: { metrics: ['sessions'], dimensions: [], total_rows: 2 },
      };
      cacheManager.get.mockResolvedValue(cachedResult);

      const result = await service.query(baseQuery);

      expect(result).toEqual(cachedResult);
      expect(clickhouse.queryWorkspace).not.toHaveBeenCalled();
      expect(cacheManager.set).not.toHaveBeenCalled();
    });

    it('executes query and caches result on cache miss', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      const result = await service.query(baseQuery);

      expect(clickhouse.queryWorkspace).toHaveBeenCalled();
      expect(cacheManager.set).toHaveBeenCalledWith(
        expect.stringMatching(/^analytics:ws-1:/),
        expect.objectContaining({ data: expect.any(Array) }),
        expect.any(Number),
      );
      expect(result.data).toBeDefined();
    });

    it('uses 5 min TTL for historical queries', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      // Query with dates in the past
      await service.query({
        ...baseQuery,
        dateRange: {
          start: '2024-01-01 00:00:00',
          end: '2024-01-02 23:59:59',
          granularity: 'day',
        },
      });

      expect(cacheManager.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        5 * 60 * 1000, // 5 minutes
      );
    });

    it('uses 1 min TTL for queries including today', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      // Query with end date as today
      const today = new Date().toISOString().split('T')[0];
      await service.query({
        ...baseQuery,
        dateRange: {
          start: '2025-01-01 00:00:00',
          end: `${today} 23:59:59`,
          granularity: 'day',
        },
      });

      expect(cacheManager.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        60 * 1000, // 1 minute
      );
    });

    it('generates different cache keys for different queries', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      await service.query(baseQuery);
      const firstCacheKey = cacheManager.set.mock.calls[0][0];

      await service.query({
        ...baseQuery,
        metrics: ['sessions', 'median_duration'],
      });
      const secondCacheKey = cacheManager.set.mock.calls[1][0];

      expect(firstCacheKey).not.toEqual(secondCacheKey);
    });

    it('generates same cache key for equivalent queries', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      await service.query(baseQuery);
      const firstCacheKey = cacheManager.set.mock.calls[0][0];

      cacheManager.set.mockClear();
      cacheManager.get.mockResolvedValue(undefined);

      await service.query(baseQuery);
      const secondCacheKey = cacheManager.set.mock.calls[0][0];

      expect(firstCacheKey).toEqual(secondCacheKey);
    });
  });

  // Ticket leak-sql 2026-06-24 : la réponse ne doit JAMAIS exposer le SQL
  // ClickHouse brut ni ses paramètres (fuite de structure interne — OWASP).
  // Le SQL reste interne au service ; seuls data + meta agrégée sortent.
  describe('SQL leak (réponse sans SQL brut)', () => {
    const baseQuery = {
      workspace_id: 'ws-1',
      metrics: ['sessions'],
      dateRange: {
        start: '2025-01-01 00:00:00',
        end: '2025-01-02 23:59:59',
        granularity: 'day' as const,
      },
    };

    it('does not expose meta.query / query.sql on a simple query', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      const result = await service.query(baseQuery);

      // Aucun champ `query` au top-level, aucun `sql` nulle part.
      expect(result).not.toHaveProperty('query');
      expect((result as Record<string, unknown>).query).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/"sql"/);
      // Le happy-path reste intact.
      expect(result.data).toBeDefined();
      expect(result.meta).toBeDefined();
    });

    it('does not expose query/sql on a comparison query', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      const result = await service.query({
        ...baseQuery,
        compareDateRange: {
          start: '2024-12-01 00:00:00',
          end: '2024-12-02 23:59:59',
        },
      });

      expect(result).not.toHaveProperty('query');
      expect(JSON.stringify(result)).not.toMatch(/"sql"/);
      expect(result.data).toBeDefined();
      expect(result.meta.compareDateRange).toBeDefined();
    });
  });

  describe('query deduplication', () => {
    const baseQuery = {
      workspace_id: 'ws-1',
      metrics: ['sessions'],
      dateRange: {
        start: '2025-01-01 00:00:00',
        end: '2025-01-02 23:59:59',
        granularity: 'day' as const,
      },
    };

    it('deduplicates concurrent identical requests', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      // Simulate slow query
      let resolveQuery: (value: unknown) => void;
      const slowQueryPromise = new Promise((resolve) => {
        resolveQuery = resolve;
      });
      clickhouse.queryWorkspace.mockReturnValue(slowQueryPromise as any);

      // Start two concurrent queries
      const promise1 = service.query(baseQuery);
      const promise2 = service.query(baseQuery);

      // Resolve the slow query
      resolveQuery!(mockQueryResult);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Both should return the same result
      expect(result1).toEqual(result2);
      // Only one actual DB query should be made
      expect(clickhouse.queryWorkspace).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache invalidation', () => {
    const baseQuery = {
      workspace_id: 'ws-1',
      metrics: ['sessions'],
      dateRange: {
        start: '2025-01-01 00:00:00',
        end: '2025-01-02 23:59:59',
        granularity: 'day' as const,
      },
    };

    it('clears workspace cache on backfill.completed event', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      // First, create some cached queries
      await service.query(baseQuery);
      await service.query({
        ...baseQuery,
        metrics: ['median_duration'],
      });

      // Trigger backfill completed event
      await service.handleBackfillCompleted({ workspaceId: 'ws-1' });

      // Should have deleted the cached keys
      expect(cacheManager.del).toHaveBeenCalledTimes(2);
    });

    it('does not clear cache for other workspaces', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      // Create cached query for ws-1
      await service.query(baseQuery);

      // Trigger backfill for different workspace
      await service.handleBackfillCompleted({ workspaceId: 'ws-2' });

      // Should not delete any keys
      expect(cacheManager.del).not.toHaveBeenCalled();
    });
  });

  describe('funnel', () => {
    it('computes step counts, per-step and overall conversion rates', async () => {
      // windowFunnel aggregate row: s0=100 reach step1, s1=40 reach step2, s2=10 reach step3.
      // v0/v1/v2 = cumulative € value at each step (A3-value).
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { s0: 100, s1: 40, s2: 10, v0: 0, v1: 0, v2: 490 },
      ]);

      const res = (await service.funnel({
        workspace_id: 'ws-1',
        steps: [
          { goal_name: 'view', label: 'Vue' },
          { goal_name: 'add_to_cart' },
          { goal_name: 'signup' },
        ],
        dateRange: { start: '2026-06-01 00:00:00', end: '2026-06-30 23:59:59' },
      })) as FunnelResponse;

      expect(res.unit).toBe('session');
      expect(res.entered).toBe(100);
      expect(res.steps).toHaveLength(3);
      expect(res.steps[0]).toMatchObject({
        step: 1,
        count: 100,
        conversion_from_previous: null,
        conversion_from_start: 100,
        dropoff_from_previous: 0,
        label: 'Vue',
      });
      expect(res.steps[1]).toMatchObject({
        step: 2,
        count: 40,
        conversion_from_previous: 40, // 40/100
        conversion_from_start: 40,
        dropoff_from_previous: 60,
        label: 'add_to_cart', // defaults to goal_name
      });
      expect(res.steps[2]).toMatchObject({
        step: 3,
        count: 10,
        conversion_from_previous: 25, // 10/40
        conversion_from_start: 10,
        dropoff_from_previous: 30,
        value: 490, // A3-value: € at the final step
      });
      expect(res.overall_conversion).toBe(10); // 10/100
      // A3-value: value carried on every step (0 where no goal_value).
      expect(res.steps.map((s) => s.value)).toEqual([0, 0, 490]);
    });

    it('handles an empty result (no sessions in funnel)', async () => {
      clickhouse.queryWorkspace.mockResolvedValueOnce([]);
      const res = (await service.funnel({
        workspace_id: 'ws-1',
        steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
        dateRange: { preset: 'previous_7_days' },
      })) as FunnelResponse;
      expect(res.entered).toBe(0);
      expect(res.overall_conversion).toBe(0);
      expect(res.steps.every((s) => s.count === 0)).toBe(true);
      expect(res.steps.every((s) => s.value === 0)).toBe(true);
    });

    it('passes a channel filter through to ClickHouse', async () => {
      clickhouse.queryWorkspace.mockResolvedValueOnce([{ s0: 5, s1: 2 }]);
      await service.funnel({
        workspace_id: 'ws-1',
        steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
        dateRange: { start: '2026-06-01 00:00:00', end: '2026-06-30 23:59:59' },
        filters: [
          { dimension: 'channel_group', operator: 'equals', values: ['ads'] },
        ],
      });
      const [, sql] = clickhouse.queryWorkspace.mock.calls[0];
      expect(sql).toContain('channel_group =');
    });

    it('segment_by returns one series per dimension value in a single query', async () => {
      // One ClickHouse row per segment value; the segment is keyed by the
      // dimension NAME alias (here stm_2). A1: ONE query, N series.
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { stm_2: 'A', s0: 100, s1: 30, v0: 0, v1: 300 },
        { stm_2: 'B', s0: 80, s1: 40, v0: 0, v1: 400 },
        { stm_2: 'C', s0: 50, s1: 10, v0: 0, v1: 100 },
      ]);

      const res = (await service.funnel({
        workspace_id: 'ws-1',
        steps: [{ goal_name: 'signup' }, { goal_name: 'purchase' }],
        dateRange: { start: '2026-06-01 00:00:00', end: '2026-06-30 23:59:59' },
        segment_by: 'stm_2',
      })) as FunnelSegmentedResponse;

      // ONE ClickHouse call (single query).
      expect(clickhouse.queryWorkspace).toHaveBeenCalledTimes(1);
      // SQL groups by the segment column AND projects it under the dim name alias.
      const [, sql] = clickhouse.queryWorkspace.mock.calls[0];
      expect(sql).toContain('stm_2 AS seg');
      expect(sql).toContain('GROUP BY seg');
      expect(sql).toContain('`stm_2`');

      expect(res.segment_by).toBe('stm_2');
      expect(res.segments).toHaveLength(3);
      const a = res.segments.find((s) => s.key === 'A')!;
      expect(a.entered).toBe(100);
      expect(a.overall_conversion).toBe(30); // 30/100
      expect(a.steps[1].value).toBe(300);
      const b = res.segments.find((s) => s.key === 'B')!;
      expect(b.overall_conversion).toBe(50); // 40/80
    });

    it('throws SEGMENT_CARDINALITY_EXCEEDED when segment_by yields too many series', async () => {
      // Builder asks SEGMENT_MAX+1 rows; > SEGMENT_MAX rows back → reject.
      const tooMany = Array.from({ length: 13 }, (_, i) => ({
        stm_2: `v${i}`,
        s0: 10,
        s1: 5,
        v0: 0,
        v1: 0,
      }));
      clickhouse.queryWorkspace.mockResolvedValueOnce(tooMany);

      await expect(
        service.funnel({
          workspace_id: 'ws-1',
          steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
          dateRange: {
            start: '2026-06-01 00:00:00',
            end: '2026-06-30 23:59:59',
          },
          segment_by: 'stm_2',
        }),
      ).rejects.toThrow(/SEGMENT_CARDINALITY_EXCEEDED|more than/);
    });

    it('rejects an unknown segment_by dimension with 400', async () => {
      await expect(
        service.funnel({
          workspace_id: 'ws-1',
          steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
          dateRange: {
            start: '2026-06-01 00:00:00',
            end: '2026-06-30 23:59:59',
          },
          segment_by: 'definitely_not_a_dim',
        }),
      ).rejects.toThrow(/Unknown dimension/);
    });
  });

  describe('conversionsByChannel', () => {
    it('computes conversion rate per channel × app using same-channel sessions', async () => {
      // 1st call: conversions per (channel_group, app)
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { channel_group: 'ads', app: 'prospection', conversions: 20 },
        { channel_group: 'seo', app: 'prospection', conversions: 5 },
      ]);
      // 2nd call: sessions per channel_group
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { channel_group: 'ads', sessions: 200 },
        { channel_group: 'seo', sessions: 100 },
      ]);

      const res = await service.conversionsByChannel({
        workspace_id: 'ws-1',
        dateRange: { start: '2026-06-01 00:00:00', end: '2026-06-30 23:59:59' },
      });

      expect(res.conversion_goals).toEqual(['signup', 'app_started']);
      const ads = res.rows.find((r) => r.channel_group === 'ads')!;
      expect(ads).toMatchObject({
        app: 'prospection',
        conversions: 20,
        sessions: 200,
        conversion_rate: 10, // 20/200
      });
      const seo = res.rows.find((r) => r.channel_group === 'seo')!;
      expect(seo.conversion_rate).toBe(5); // 5/100
    });

    it('guards conversions with session_id != \'\' to align with the funnel', async () => {
      // The funnel (session mode) excludes goals with empty session_id; the
      // conversions query MUST apply the same guard so funnel == conversions for
      // any data state (ticket funnel-vs-conversions-divergent). Assert the
      // load-bearing clause is present in the emitted SQL.
      clickhouse.queryWorkspace.mockResolvedValueOnce([]);
      clickhouse.queryWorkspace.mockResolvedValueOnce([]);
      await service.conversionsByChannel({
        workspace_id: 'ws-1',
        dateRange: { start: '2026-06-01 00:00:00', end: '2026-06-30 23:59:59' },
      });
      // 1st queryWorkspace call = the conversions (goals) query.
      const convSql = clickhouse.queryWorkspace.mock.calls[0][1] as string;
      expect(convSql).toContain("session_id != ''");
    });

    it('labels missing app and tolerates channel with no sessions', async () => {
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { channel_group: 'direct', app: '', conversions: 3 },
      ]);
      clickhouse.queryWorkspace.mockResolvedValueOnce([]); // no sessions rows
      const res = await service.conversionsByChannel({
        workspace_id: 'ws-1',
        dateRange: { preset: 'previous_30_days' },
      });
      expect(res.rows[0]).toMatchObject({
        app: '(non renseigné)',
        conversions: 3,
        sessions: 0,
        conversion_rate: 0,
      });
    });

    it('rate per row = conversions(channel,app) / sessions(channel), never > 100%', async () => {
      // Two apps share the same channel ("ads"): each row's rate must be its own
      // conversions over the channel's sessions, and clamped at 100% (a goal can
      // reference a session outside the window => conversions > channel sessions).
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { channel_group: 'ads', app: 'prospection', conversions: 30 },
        { channel_group: 'ads', app: 'notifuse', conversions: 120 }, // > sessions
      ]);
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { channel_group: 'ads', sessions: 100 },
      ]);

      const res = await service.conversionsByChannel({
        workspace_id: 'ws-1',
        dateRange: { start: '2026-06-01 00:00:00', end: '2026-06-30 23:59:59' },
      });

      const prospection = res.rows.find((r) => r.app === 'prospection')!;
      expect(prospection.conversion_rate).toBe(30); // 30/100, own numerator
      const notifuse = res.rows.find((r) => r.app === 'notifuse')!;
      // 120/100 = 120% clamped to 100, never a > 100% rate shown to a client.
      expect(notifuse.conversion_rate).toBe(100);
      // Both rows keep the channel's session count as denominator (labelled
      // "Sessions du canal" in the console), not a per-app phantom number.
      expect(prospection.sessions).toBe(100);
      expect(notifuse.sessions).toBe(100);
    });

    it('queries sessions denominator with uniqExact(id), not count() (stable)', async () => {
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { channel_group: 'direct', app: 'prospection', conversions: 1 },
      ]);
      clickhouse.queryWorkspace.mockResolvedValueOnce([
        { channel_group: 'direct', sessions: 10 },
      ]);
      await service.conversionsByChannel({
        workspace_id: 'ws-1',
        dateRange: { start: '2026-06-01 00:00:00', end: '2026-06-30 23:59:59' },
      });
      // 2nd queryWorkspace call = the sessions denominator query.
      const sessSql = clickhouse.queryWorkspace.mock.calls[1][1] as string;
      expect(sessSql).toContain('uniqExact(id) AS sessions');
      expect(sessSql).not.toContain('count() AS sessions');
    });
  });
});

/**
 * Memory-leak guard: the per-workspace tracked-key Set is bounded (oldest-first
 * eviction). `cacheManager` expires entries by TTL, but the tracking Set only
 * shrank on `backfill.completed` — which may never fire — so without a cap it
 * grew forever (slow OOM on the long-running process). This suite drives more
 * distinct queries than the cap and asserts the Set never exceeds it, and that
 * eviction also drops the evicted key from the cache (consistency).
 *
 * Built in its OWN module so the small cap ENV is read at construction time.
 */
describe('AnalyticsService cache-key tracking is bounded (no leak)', () => {
  const CAP = 5;
  let service: AnalyticsService;
  let cacheManager: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let prevEnv: string | undefined;

  const mockWorkspace = {
    id: 'ws-leak',
    name: 'Leak WS',
    website: 'https://example.com',
    timezone: 'UTC',
    currency: 'USD',
    status: 'active',
    created_at: '2025-01-01 00:00:00',
    updated_at: '2025-01-01 00:00:00',
    settings: {
      timescore_reference: 180,
      bounce_threshold: 10,
      custom_dimensions: {},
      filters: [],
      integrations: [],
      geo_enabled: true,
      geo_store_city: true,
      geo_store_region: true,
      geo_coordinates_precision: 2,
    },
  } as unknown as Workspace;

  beforeAll(async () => {
    prevEnv = process.env.ANALYTICS_CACHE_KEYS_MAX_PER_WORKSPACE;
    process.env.ANALYTICS_CACHE_KEYS_MAX_PER_WORKSPACE = String(CAP);

    cacheManager = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: ClickHouseService,
          useValue: { queryWorkspace: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: WorkspacesService,
          useValue: { get: jest.fn().mockResolvedValue(mockWorkspace) },
        },
        { provide: CACHE_MANAGER, useValue: cacheManager },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  afterAll(() => {
    process.env.ANALYTICS_CACHE_KEYS_MAX_PER_WORKSPACE = prevEnv;
  });

  it('caps the tracked-key Set at the configured max and evicts oldest from cache', async () => {
    const N = CAP * 4; // 20 distinct queries, cap is 5
    for (let i = 0; i < N; i++) {
      await service.query({
        workspace_id: 'ws-leak',
        metrics: ['sessions'],
        // `limit` is part of the cache key → each i yields a distinct key.
        limit: 100 + i,
        dateRange: {
          start: '2025-01-01 00:00:00',
          end: '2025-01-02 23:59:59',
          granularity: 'day',
        },
      } as AnalyticsQueryDtoLike);
    }

    // Inspect the private tracking Map via a typed accessor (real state, no mock).
    const keys = (
      service as unknown as {
        workspaceCacheKeys: Map<string, Set<string>>;
      }
    ).workspaceCacheKeys.get('ws-leak');

    expect(keys).toBeDefined();
    expect(keys!.size).toBe(CAP); // never grows past the cap
    expect(keys!.size).toBeLessThanOrEqual(CAP);

    // Each eviction past the cap dropped the oldest key from the cache too.
    // N distinct keys, cap CAP → N - CAP evictions.
    expect(cacheManager.del).toHaveBeenCalledTimes(N - CAP);
  });
});

// Minimal structural alias to satisfy the query() signature in this suite
// without importing the full DTO class (avoids class-validator noise in a unit).
type AnalyticsQueryDtoLike = Parameters<AnalyticsService['query']>[0];
