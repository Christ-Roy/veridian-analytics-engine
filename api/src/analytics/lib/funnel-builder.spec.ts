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
});
