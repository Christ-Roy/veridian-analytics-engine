import { METRICS } from './metrics';

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
});
