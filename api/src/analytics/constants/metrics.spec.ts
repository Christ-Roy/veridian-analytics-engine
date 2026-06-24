import { METRICS, getMetricSql } from './metrics';

/**
 * Registry-contract guard.
 *
 * Regression context (2026-06-23): vague 2 commit 3fe98f8 reworked the
 * `pageviews` metric on a stale tree that predated `unique_visitors` (added by
 * fd91e83), silently dropping `unique_visitors` from the registry. The unit
 * tests for workspaces.status mock `AnalyticsService.query`, so they never
 * exercised the real metric lookup — the missing metric only surfaced in prod
 * as `Unknown metric: unique_visitors`, which made `probeTracking` throw and
 * return sessions_30d/visitors_30d=0 (status looked dead while data was intact).
 *
 * These tests pin the metrics that consolidated status (`probeTracking` /
 * `countMetric` in admin-platform.service.ts) hard-depends on, so a future
 * collision that drops one fails CI instead of shipping a silent status zero.
 */
describe('METRICS registry — status probe contract', () => {
  // Keep in sync with admin-platform.service.ts probeTracking/countMetric.
  const STATUS_PROBE_METRICS = ['sessions', 'unique_visitors'] as const;

  it.each(STATUS_PROBE_METRICS)(
    'registers the "%s" metric used by workspaces.status',
    (metric) => {
      expect(METRICS[metric]).toBeDefined();
    },
  );

  it.each(STATUS_PROBE_METRICS)(
    'exposes "%s" on the sessions table (status queries table: sessions)',
    (metric) => {
      expect(METRICS[metric].tables).toContain('sessions');
    },
  );

  it('computes unique_visitors as distinct visitor_id (B2B real visitors)', () => {
    expect(METRICS.unique_visitors.sql).toBe('uniqExact(visitor_id)');
  });

  /**
   * Stability contract (2026-06-24): the `sessions` metric MUST dedup by session
   * identity, not count rows. On `sessions FINAL` (ReplacingMergeTree fed by
   * sessions_mv re-inserting a row per event block), count() counts un-merged
   * duplicate rows, so the same query returned 147 then 160 between two refreshes
   * while uniqExact(visitor_id) stayed stable. uniqExact(id) is immune to
   * duplicate rows => deterministic total. Pin it so a future "optimization" back
   * to count() fails CI instead of shipping a number that moves on refresh.
   */
  it('computes sessions as uniqExact(id) (deterministic on FINAL, not count())', () => {
    expect(METRICS.sessions.sql).toBe('uniqExact(id)');
  });

  it('computes bounce_rate with identity-based dedup (uniqExact, not count())', () => {
    const sql = getMetricSql(METRICS.bounce_rate, { bounce_threshold: 10 });
    expect(sql).toContain('uniqExactIf(id, duration < 10000)');
    expect(sql).toContain('uniqExact(id)');
    expect(sql).not.toContain('count()');
  });
});
