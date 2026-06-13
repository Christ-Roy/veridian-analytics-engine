import { TwentyEventMapper, TrackedEventContext } from './twenty-event-mapper';

function ctx(partial: Partial<TrackedEventContext>): TrackedEventContext {
  return {
    workspace_id: partial.workspace_id ?? 'vrd_test',
    event_type: partial.event_type ?? 'goal',
    event_id: partial.event_id ?? 'evt_1',
    payload: { ...(partial.payload ?? {}) },
  };
}

describe('TwentyEventMapper', () => {
  let mapper: TwentyEventMapper;

  beforeEach(() => {
    mapper = new TwentyEventMapper();
  });

  describe('identity resolution (§4a/§4c.1)', () => {
    it('returns null when there is no user_id', () => {
      expect(mapper.map(ctx({ payload: { goal_name: 'rdv_booked' } }))).toBeNull();
    });

    it('lowercases + trims an email identity', () => {
      const out = mapper.map(
        ctx({ payload: { goal_name: 'rdv_booked', user_id: '  ROBERT@Veridian.SITE ' } }),
      );
      expect(out?.identity).toBe('robert@veridian.site');
    });

    it('passes a slug through verbatim (secret-derived, case-sensitive)', () => {
      const out = mapper.map(
        ctx({ payload: { goal_name: 'rdv_booked', user_id: 'monsite-Ab3xZ9k2' } }),
      );
      expect(out?.identity).toBe('monsite-Ab3xZ9k2');
    });

    it('normalizeIdentity rejects empty / non-string', () => {
      expect(mapper.normalizeIdentity('')).toBeNull();
      expect(mapper.normalizeIdentity('   ')).toBeNull();
      expect(mapper.normalizeIdentity(null)).toBeNull();
      expect(mapper.normalizeIdentity(42)).toBeNull();
    });
  });

  describe('screen_view mapping', () => {
    it('maps a shallow /audit/ view to audit.page_view', () => {
      const out = mapper.map(
        ctx({
          event_type: 'screen_view',
          payload: { path: '/audit/monsite-ab3x', max_scroll: 30, user_id: 's-1' },
        }),
      );
      expect(out?.name).toBe('audit.page_view');
    });

    it('maps a deep /audit/ view (scroll >= 75) to audit.scroll', () => {
      const out = mapper.map(
        ctx({
          event_type: 'screen_view',
          payload: { path: '/audit/monsite-ab3x', max_scroll: 80, user_id: 's-1' },
        }),
      );
      expect(out?.name).toBe('audit.scroll');
    });

    it('ignores a non-audit page view (not a timeline milestone)', () => {
      const out = mapper.map(
        ctx({
          event_type: 'screen_view',
          payload: { path: '/tarifs', user_id: 's-1' },
        }),
      );
      expect(out).toBeNull();
    });
  });

  describe('goal mapping (§4c.3)', () => {
    it.each([
      ['audit_view', 'audit.page_view'],
      ['audit_page_view', 'audit.page_view'],
      ['audit_cta_rdv', 'audit.cta_click'],
      ['appointment_click', 'audit.cta_click'],
      ['roi_lead_click', 'audit.cta_click'],
      ['cta_click', 'audit.cta_click'],
      ['rdv_booked', 'audit.rdv'],
      ['signup', 'signup'],
    ])('maps raw goal %s → %s', (goal, expected) => {
      const out = mapper.map(
        ctx({ event_type: 'goal', payload: { goal_name: goal, user_id: 'a@b.com' } }),
      );
      expect(out?.name).toBe(expected);
    });

    it('maps audit_scroll with depth >= 75 to audit.scroll', () => {
      const out = mapper.map(
        ctx({
          event_type: 'goal',
          payload: { goal_name: 'audit_scroll', properties: { depth: 100 }, user_id: 'a@b.com' },
        }),
      );
      expect(out?.name).toBe('audit.scroll');
    });

    it('ignores audit_scroll with depth < 75', () => {
      const out = mapper.map(
        ctx({
          event_type: 'goal',
          payload: { goal_name: 'audit_scroll', properties: { depth: 50 }, user_id: 'a@b.com' },
        }),
      );
      expect(out).toBeNull();
    });

    it('app_started → app.started only for whitelisted apps (notifuse/prospection)', () => {
      for (const app of ['notifuse', 'prospection']) {
        const out = mapper.map(
          ctx({
            event_type: 'goal',
            payload: { goal_name: 'app_started', properties: { app }, user_id: 'a@b.com' },
          }),
        );
        expect(out?.name).toBe('app.started');
      }
    });

    it('app_started with roi-calculator is EXCLUDED (§4a-bis)', () => {
      const out = mapper.map(
        ctx({
          event_type: 'goal',
          payload: { goal_name: 'app_started', properties: { app: 'roi-calculator' }, user_id: 'a@b.com' },
        }),
      );
      expect(out).toBeNull();
    });

    it('ignores an unknown goal', () => {
      const out = mapper.map(
        ctx({ event_type: 'goal', payload: { goal_name: 'newsletter_signup', user_id: 'a@b.com' } }),
      );
      expect(out).toBeNull();
    });
  });

  describe('happensAt (§4c.2 — true event time, ISO UTC)', () => {
    it('prefers goal_timestamp and normalizes ClickHouse format to ISO', () => {
      const out = mapper.map(
        ctx({
          event_type: 'goal',
          payload: {
            goal_name: 'rdv_booked',
            goal_timestamp: '2026-06-10 11:36:52.498',
            user_id: 'a@b.com',
          },
        }),
      );
      expect(out?.happensAt).toBe('2026-06-10T11:36:52.498Z');
    });

    it('accepts an ISO string', () => {
      const out = mapper.map(
        ctx({
          event_type: 'goal',
          payload: { goal_name: 'rdv_booked', event_timestamp: '2026-06-10T09:00:00.000Z', user_id: 'a@b.com' },
        }),
      );
      expect(out?.happensAt).toBe('2026-06-10T09:00:00.000Z');
    });

    it('accepts epoch ms', () => {
      const ms = Date.UTC(2026, 5, 10, 8, 0, 0);
      const out = mapper.map(
        ctx({
          event_type: 'goal',
          payload: { goal_name: 'rdv_booked', event_timestamp: ms, user_id: 'a@b.com' },
        }),
      );
      expect(out?.happensAt).toBe(new Date(ms).toISOString());
    });

    it('falls back to now() when no timestamp is usable', () => {
      const before = Date.now();
      const out = mapper.map(
        ctx({ event_type: 'goal', payload: { goal_name: 'rdv_booked', user_id: 'a@b.com' } }),
      );
      const ts = Date.parse(out!.happensAt);
      expect(ts).toBeGreaterThanOrEqual(before);
    });
  });

  describe('properties (audit trail §4.3)', () => {
    it('carries eventId, source, url, goalName and utm', () => {
      const out = mapper.map(
        ctx({
          event_id: 'evt_42',
          event_type: 'goal',
          payload: {
            goal_name: 'audit_cta_rdv',
            path: '/audit/x',
            user_id: 'a@b.com',
            utm: { source: 'google_ads', campaign: 'spring' },
          },
        }),
      );
      expect(out?.properties).toMatchObject({
        eventId: 'evt_42',
        source: 'analytics',
        url: '/audit/x',
        goalName: 'audit_cta_rdv',
        utmSource: 'google_ads',
        utmCampaign: 'spring',
      });
      expect(out?.eventId).toBe('evt_42');
    });
  });
});
