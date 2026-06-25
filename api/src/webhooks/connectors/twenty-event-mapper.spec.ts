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

    it('maps a deep /audit/ view to BOTH audit.page_view AND audit.scroll', () => {
      // A deep audit view must NOT drop the page_view (the reference emits both).
      const out = mapper.mapAll(
        ctx({
          event_type: 'screen_view',
          payload: { path: '/audit/monsite-ab3x', max_scroll: 80, user_id: 's-1' },
        }),
      );
      expect(out.map((m) => m.name).sort()).toEqual(['audit.page_view', 'audit.scroll']);
      // both carry the same eventId; the connector derives distinct ids from
      // (personId, eventId, name) after resolution, so the two names suffice here.
      expect(out.every((m) => m.eventId === out[0].eventId)).toBe(true);
    });

    it('maps a shallow /audit/ view to ONLY audit.page_view', () => {
      const out = mapper.mapAll(
        ctx({
          event_type: 'screen_view',
          payload: { path: '/audit/x', max_scroll: 30, user_id: 's-1' },
        }),
      );
      expect(out.map((m) => m.name)).toEqual(['audit.page_view']);
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

  // ─── N4 — config-driven generic engine (multi-industrie) ────────────────
  describe('config-driven mapping (N4)', () => {
    it('uses workspace goals catalogue instead of the built-in Sets', () => {
      const config = {
        goals: [
          { match: 'goal:purchase', timeline_name: 'achat' },
          { match: 'goal:reservation_confirmed', timeline_name: 'reservation' },
        ],
      };
      // 'purchase' is unknown to the built-in mapping → only the config maps it.
      const out = mapper.map(
        ctx({ payload: { goal_name: 'purchase', user_id: 'a@b.com' } }),
        config,
      );
      expect(out?.name).toBe('achat');
    });

    it('ignores built-in prospection goals once a config is declared', () => {
      const config = { goals: [{ match: 'goal:purchase', timeline_name: 'achat' }] };
      // 'rdv_booked' is a built-in goal but NOT in this workspace's config.
      const out = mapper.mapAll(
        ctx({ payload: { goal_name: 'rdv_booked', user_id: 'a@b.com' } }),
        config,
      );
      expect(out).toEqual([]);
    });

    it('matches screen_view path prefixes with a scroll threshold', () => {
      const config = {
        goals: [
          { match: 'screen_view:/cours/', timeline_name: 'vue_cours', min_scroll: 50 },
        ],
      };
      const shallow = mapper.mapAll(
        ctx({ event_type: 'screen_view', payload: { path: '/cours/yoga', max_scroll: 20, user_id: 'a@b.com' } }),
        config,
      );
      expect(shallow).toEqual([]);
      const deep = mapper.mapAll(
        ctx({ event_type: 'screen_view', payload: { path: '/cours/yoga', max_scroll: 80, user_id: 'a@b.com' } }),
        config,
      );
      expect(deep[0]?.name).toBe('vue_cours');
    });

    it('falls back to the built-in mapping when no config is given', () => {
      const out = mapper.map(ctx({ payload: { goal_name: 'rdv_booked', user_id: 'a@b.com' } }));
      expect(out?.name).toBe('audit.rdv');
    });
  });

  describe('configurable identity resolution (N4)', () => {
    it("resolver 'field' carries the field + opaque id verbatim", () => {
      const config = {
        identity_resolver: 'field' as const,
        identity_field: 'supabaseId',
        goals: [{ match: 'goal:purchase', timeline_name: 'achat' }],
      };
      const uuid = 'a1b2-c3d4';
      const out = mapper.map(ctx({ payload: { goal_name: 'purchase', user_id: uuid } }), config);
      expect(out?.identity).toBe(uuid);
      expect(out?.identityKind).toBe('field');
      expect(out?.identityField).toBe('supabaseId');
    });

    it("resolver 'field' without a field name yields no milestone", () => {
      const config = {
        identity_resolver: 'field' as const,
        goals: [{ match: 'goal:purchase', timeline_name: 'achat' }],
      };
      expect(mapper.mapAll(ctx({ payload: { goal_name: 'purchase', user_id: 'x' } }), config)).toEqual([]);
    });

    it("resolver 'email' forces an email lookup even for a bare token", () => {
      const r = mapper.resolveIdentity('Robert@Veridian.SITE', { identity_resolver: 'email' });
      expect(r).toEqual({ identity: 'robert@veridian.site', identityKind: 'email' });
    });

    it("default 'auto' branches on the value shape", () => {
      expect(mapper.resolveIdentity('a@b.com').identityKind).toBe('email');
      expect(mapper.resolveIdentity('slug-x').identityKind).toBe('slug');
    });
  });

  // ─── S4 — phone_call mapping + normalized acquisition source ─────────────
  describe('phone_call + acquisition source (S4)', () => {
    it('maps a phone_call goal to the default "appel" milestone', () => {
      const out = mapper.map(
        ctx({ payload: { goal_name: 'phone_call', user_id: 'a@b.com', properties: { source: 'seo' } } }),
      );
      expect(out?.name).toBe('appel');
      expect(out?.properties).toMatchObject({ phoneSource: 'seo', acquisitionSource: 'organic_seo' });
    });

    it('honors a custom phone_call_timeline_name and can be disabled', () => {
      const named = mapper.map(
        ctx({ payload: { goal_name: 'phone_call', user_id: 'a@b.com', properties: { source: 'ads' } } }),
        { phone_call_timeline_name: 'appel_entrant' },
      );
      expect(named?.name).toBe('appel_entrant');
      const off = mapper.mapAll(
        ctx({ payload: { goal_name: 'phone_call', user_id: 'a@b.com' } }),
        { map_phone_calls: false },
      );
      expect(off).toEqual([]);
    });

    it('normalizes acquisition source with the priority order', () => {
      expect(mapper.acquisitionSource({ utm: { id_from: 'gclid' } })).toBe('google_ads');
      expect(mapper.acquisitionSource({ properties: { source: 'ads' } })).toBe('google_ads');
      expect(mapper.acquisitionSource({ referrer_domain: 'www.google.com' })).toBe('organic_seo');
      expect(mapper.acquisitionSource({ utm: { medium: 'cpc' } })).toBe('paid_other');
      expect(mapper.acquisitionSource({ utm: { medium: 'email' } })).toBe('email');
      expect(mapper.acquisitionSource({ referrer_domain: 'facebook.com' })).toBe('social');
      expect(mapper.acquisitionSource({ referrer_domain: 'partner.fr' })).toBe('referral');
      expect(mapper.acquisitionSource({})).toBe('direct');
    });
  });

  // ─── S6 — stitched first-touch overrides the event-based S4 channel ───────
  describe('first-touch attribution (S6)', () => {
    it('maps a stitched channel_group to the S4 vocabulary', () => {
      const fp = (g: string) => ({ channelGroup: g, channel: '', referralCode: '' });
      expect(mapper.acquisitionFromFirstTouch(fp('ads'))).toBe('google_ads');
      expect(mapper.acquisitionFromFirstTouch(fp('seo'))).toBe('organic_seo');
      expect(mapper.acquisitionFromFirstTouch(fp('social'))).toBe('social');
      expect(mapper.acquisitionFromFirstTouch(fp('email'))).toBe('email');
      expect(mapper.acquisitionFromFirstTouch(fp('referral'))).toBe('referral');
      // direct / other / empty → '' (no acquisition to surface, S4 fallback)
      expect(mapper.acquisitionFromFirstTouch(fp('direct'))).toBe('');
      expect(mapper.acquisitionFromFirstTouch(fp('other'))).toBe('');
      expect(mapper.acquisitionFromFirstTouch(fp(''))).toBe('');
    });

    it('a signup /login event (direct) gets the stitched provenance, not direct', () => {
      // No referrer / utm on the event → S4 alone = direct. With a stitched
      // first-touch the property becomes the real acquisition + referralCode.
      const out = mapper.mapAll(
        ctx({ payload: { goal_name: 'signup', user_id: 'jo@yoga.fr' } }),
        undefined,
        { channelGroup: 'ads', channel: 'paid_search', referralCode: 'AB12' },
      );
      expect(out[0].name).toBe('signup');
      expect(out[0].properties).toMatchObject({
        acquisitionSource: 'google_ads',
        referralCode: 'AB12',
      });
    });

    it('without a stitched first-touch the signup stays S4 direct', () => {
      const out = mapper.mapAll(
        ctx({ payload: { goal_name: 'signup', user_id: 'jo@yoga.fr' } }),
      );
      expect(out[0].properties.acquisitionSource).toBe('direct');
      expect(out[0].properties.referralCode).toBeUndefined();
    });
  });
});
