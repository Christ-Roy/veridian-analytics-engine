import { buildFunnelQuery } from './funnel-builder';

describe('buildFunnelQuery', () => {
  const base = {
    start: '2026-06-01 00:00:00',
    end: '2026-06-30 23:59:59',
    windowSeconds: 2_592_000,
    unit: 'session' as const,
  };

  it('builds a windowFunnel over the goals table with one param per step', () => {
    const { sql, params } = buildFunnelQuery({
      ...base,
      steps: [{ goal_name: 'view' }, { goal_name: 'signup' }],
    });
    expect(sql).toContain('windowFunnel({window:UInt32})');
    expect(sql).toContain('FROM goals');
    expect(sql).toContain('goal_name = {step0:String}');
    expect(sql).toContain('goal_name = {step1:String}');
    expect(sql).toContain('countIf(level >= 1) AS s0');
    expect(sql).toContain('countIf(level >= 2) AS s1');
    expect(params.step0).toBe('view');
    expect(params.step1).toBe('signup');
    expect(params.window).toBe(2_592_000);
    expect(params.start).toBe(base.start);
    expect(params.end).toBe(base.end);
  });

  it('groups by session_id in session mode and guards empties', () => {
    const { sql } = buildFunnelQuery({
      ...base,
      steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
    });
    expect(sql).toContain('session_id AS g');
    expect(sql).toContain('GROUP BY session_id');
    expect(sql).toContain(`AND session_id != ''`);
  });

  it('groups by visitor_id in visitor mode and excludes empty visitor_id', () => {
    const { sql } = buildFunnelQuery({
      ...base,
      unit: 'visitor',
      steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
    });
    expect(sql).toContain('visitor_id AS g');
    expect(sql).toContain('GROUP BY visitor_id');
    expect(sql).toContain(`AND visitor_id != ''`);
  });

  it('compiles a channel_group filter into the WHERE clause', () => {
    const { sql, params } = buildFunnelQuery({
      ...base,
      steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
      filters: [
        { dimension: 'channel_group', operator: 'equals', values: ['ads'] },
      ],
    });
    expect(sql).toContain('channel_group =');
    // filter params are prefixed with 'ff'
    expect(Object.keys(params).some((k) => k.startsWith('ff'))).toBe(true);
    expect(Object.values(params)).toContain('ads');
  });

  it('rejects a filter on a dimension not available for goals', () => {
    expect(() =>
      buildFunnelQuery({
        ...base,
        steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
        filters: [
          // is_landing is a pages-only dimension → should throw
          { dimension: 'unknown_dim', operator: 'equals', values: ['x'] },
        ],
      }),
    ).toThrow();
  });

  // ─── A3-value: € per step (always emitted, additive, non-breaking) ─────────
  it('always emits sumIf(goal_value) per step alongside the count', () => {
    const { sql } = buildFunnelQuery({
      ...base,
      steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
    });
    // Inner subquery carries the per-unit total value up.
    expect(sql).toContain('sum(goal_value) AS value');
    // Outer aggregate sums value for units reaching each step.
    expect(sql).toContain('sumIf(value, level >= 1) AS v0');
    expect(sql).toContain('sumIf(value, level >= 2) AS v1');
  });

  // ─── A1: segment_by → one series per dimension value in ONE query ─────────
  describe('segment_by (A1)', () => {
    it('adds the segment column to the inner SELECT, both GROUP BYs and a LIMIT', () => {
      const { sql } = buildFunnelQuery({
        ...base,
        steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
        segment: { column: 'channel_group', name: 'channel_group', limit: 13 },
      });
      // Projected under the dimension name alias in the outer SELECT.
      expect(sql).toContain('channel_group AS seg');
      expect(sql).toContain('`channel_group`');
      // Inner GROUP BY keeps the segment per unit; outer GROUP BY aggregates it.
      expect(sql).toContain('GROUP BY session_id, seg');
      expect(sql).toContain('GROUP BY seg');
      // Cardinality guard.
      expect(sql).toContain('LIMIT 13');
      expect(sql).toContain('ORDER BY s0 DESC');
    });

    it('aliases a Map-accessor segment column back to the dimension name', () => {
      const { sql } = buildFunnelQuery({
        ...base,
        steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
        segment: {
          column: "properties['variant']",
          name: 'variant',
          limit: 13,
        },
      });
      expect(sql).toContain("properties['variant'] AS seg");
      expect(sql).toContain('`variant`');
      expect(sql).toContain('GROUP BY session_id, seg');
    });

    it('emits NO segment clauses when segment is absent (retro-compat)', () => {
      const { sql } = buildFunnelQuery({
        ...base,
        steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
      });
      expect(sql).not.toContain('AS seg');
      expect(sql).not.toContain('GROUP BY seg');
      expect(sql).not.toContain('LIMIT');
      // The mono-series outer GROUP BY on the unit must NOT appear (no outer
      // grouping at all in mono mode — single aggregate row).
      expect(sql).toContain('GROUP BY session_id');
    });
  });
});
