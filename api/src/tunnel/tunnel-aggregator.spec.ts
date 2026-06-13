import { aggregateEvents, toAggregates, RawEventRow } from './tunnel-aggregator';

function ev(partial: Partial<RawEventRow>): RawEventRow {
  return {
    user_id: 'a@b.com',
    session_id: 's1',
    name: 'goal',
    path: '/',
    max_scroll: 0,
    goal_name: '',
    properties: {},
    goal_timestamp: '2026-06-10 09:00:00.000',
    updated_at: '2026-06-10 09:00:00.000',
    ...partial,
  };
}

describe('tunnel-aggregator', () => {
  it('ignores anonymous events (no user_id)', () => {
    const map = aggregateEvents([ev({ user_id: null, goal_name: 'rdv_booked' })]);
    expect(toAggregates(map)).toEqual([]);
  });

  it('aggregates screen_views: audit views, scroll max, unique hot/other pages', () => {
    const map = aggregateEvents([
      ev({ name: 'screen_view', path: '/audit/x', max_scroll: 40 }),
      ev({ name: 'screen_view', path: '/audit/x', max_scroll: 90 }),
      ev({ name: 'screen_view', path: '/tarifs' }),
      ev({ name: 'screen_view', path: '/tarifs' }), // dup hot → still 1
      ev({ name: 'screen_view', path: '/contact' }),
      ev({ name: 'screen_view', path: '/blog/a' }),
      ev({ name: 'screen_view', path: '/blog/b' }),
    ]);
    const [a] = toAggregates(map);
    expect(a.auditViews).toBe(2);
    expect(a.auditScrollMax).toBe(90);
    expect(a.hotPages).toBe(2); // /tarifs + /contact unique
    expect(a.otherPages).toBe(2); // /blog/a + /blog/b
  });

  it('maps CTA / RDV / consent goals', () => {
    const map = aggregateEvents([
      ev({ goal_name: 'audit_cta_rdv' }),
      ev({ goal_name: 'appointment_click' }),
      ev({ goal_name: 'rdv_booked' }),
      ev({ goal_name: 'consent_granted' }),
    ]);
    const [a] = toAggregates(map);
    expect(a.ctaClicks).toBe(2);
    expect(a.rdvBooked).toBe(1);
    expect(a.consented).toBe(true);
  });

  it('counts audit_view / audit_scroll goals', () => {
    const map = aggregateEvents([
      ev({ goal_name: 'audit_view' }),
      ev({ goal_name: 'audit_scroll', properties: { depth: '100' } }),
    ]);
    const [a] = toAggregates(map);
    expect(a.auditViews).toBe(1);
    expect(a.auditScrollMax).toBe(100);
  });

  it('sets appStarted only for whitelisted apps (notifuse/prospection)', () => {
    expect(toAggregates(aggregateEvents([ev({ goal_name: 'app_started', properties: { app: 'notifuse' } })]))[0].appStarted).toBe(true);
    expect(toAggregates(aggregateEvents([ev({ goal_name: 'app_started', properties: { app: 'prospection' } })]))[0].appStarted).toBe(true);
    expect(toAggregates(aggregateEvents([ev({ goal_name: 'app_started', properties: { app: 'roi-calculator' } })]))[0].appStarted).toBe(false);
  });

  it('signup goal flips identifiedByEmail', () => {
    const map = aggregateEvents([ev({ user_id: 'slug-x', goal_name: 'signup' })]);
    expect(toAggregates(map)[0].identifiedByEmail).toBe(true);
  });

  it('identifiedByEmail defaults from the identity shape (@)', () => {
    expect(toAggregates(aggregateEvents([ev({ user_id: 'me@x.com', goal_name: 'rdv_booked' })]))[0].identifiedByEmail).toBe(true);
    expect(toAggregates(aggregateEvents([ev({ user_id: 'slug-y', goal_name: 'rdv_booked' })]))[0].identifiedByEmail).toBe(false);
  });

  it('counts distinct sessions', () => {
    const map = aggregateEvents([
      ev({ session_id: 's1', goal_name: 'rdv_booked' }),
      ev({ session_id: 's2', name: 'screen_view', path: '/audit/x' }),
      ev({ session_id: 's2', name: 'screen_view', path: '/tarifs' }),
    ]);
    expect(toAggregates(map)[0].sessions).toBe(2);
  });

  it('tracks the most recent lastSeen as ISO', () => {
    const map = aggregateEvents([
      ev({ goal_name: 'rdv_booked', goal_timestamp: '2026-06-10 09:00:00.000' }),
      ev({ goal_name: 'cta_click', goal_timestamp: '2026-06-10 11:30:00.000' }),
    ]);
    expect(toAggregates(map)[0].lastSeen).toBe('2026-06-10T11:30:00.000Z');
  });

  it('keeps identities separate (bridge unions slug↔email itself)', () => {
    const map = aggregateEvents([
      ev({ user_id: 'slug-z', name: 'screen_view', path: '/audit/z', max_scroll: 80 }),
      ev({ user_id: 'z@x.com', goal_name: 'rdv_booked' }),
    ]);
    const aggs = toAggregates(map);
    expect(aggs).toHaveLength(2);
    expect(aggs.find((a) => a.userId === 'slug-z')?.auditViews).toBe(1);
    expect(aggs.find((a) => a.userId === 'z@x.com')?.rdvBooked).toBe(1);
  });

  it('invariant: 2 distinct CTA + audit signals accumulate (full shape present)', () => {
    const map = aggregateEvents([
      ev({ name: 'screen_view', path: '/audit/x', max_scroll: 80 }),
      ev({ goal_name: 'audit_cta_rdv' }),
      ev({ goal_name: 'appointment_click' }),
    ]);
    const [a] = toAggregates(map);
    // every contract field is present and typed
    expect(a).toEqual({
      userId: 'a@b.com',
      auditViews: 1,
      auditScrollMax: 80,
      hotPages: 0,
      otherPages: 0,
      consented: false,
      ctaClicks: 2,
      rdvBooked: 0,
      identifiedByEmail: true,
      appStarted: false,
      sessions: 1,
      lastSeen: '2026-06-10T09:00:00.000Z',
    });
  });

  it('accumulates across pages (cursor pagination keeps the same map)', () => {
    let map = aggregateEvents([ev({ goal_name: 'cta_click' })]);
    map = aggregateEvents([ev({ goal_name: 'cta_click' })], map);
    expect(toAggregates(map)[0].ctaClicks).toBe(2);
  });
});
