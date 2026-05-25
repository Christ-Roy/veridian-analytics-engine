import {
  generateVoipCalls,
  DEMO_TRACKED_NUMBERS,
  type DemoPhoneSource,
} from './voip-calls';

describe('generateVoipCalls', () => {
  const baseConfig = {
    workspaceId: 'demo-apple',
    endDate: new Date('2026-05-25T12:00:00.000Z'),
    daysRange: 30,
    callCount: 30,
  };

  it('generates the requested number of events', () => {
    const events = generateVoipCalls(baseConfig);
    expect(events).toHaveLength(30);
  });

  it('honours custom callCount', () => {
    const events = generateVoipCalls({ ...baseConfig, callCount: 5 });
    expect(events).toHaveLength(5);
  });

  it('produces only goal events named "phone_call"', () => {
    const events = generateVoipCalls(baseConfig);
    for (const ev of events) {
      expect(ev.name).toBe('goal');
      expect(ev.goal_name).toBe('phone_call');
      expect(ev.goal_value).toBeGreaterThanOrEqual(5);
    }
  });

  it('attaches the source dimension in properties (vision 2026-05-25)', () => {
    const events = generateVoipCalls(baseConfig);
    const validSources: DemoPhoneSource[] = ['seo', 'ads', 'direct'];
    for (const ev of events) {
      expect(ev.properties).toBeDefined();
      expect(ev.properties!.source).toBeDefined();
      expect(validSources).toContain(
        ev.properties!.source as DemoPhoneSource,
      );
      // tracked_number_id must be one of the demo numbers' ids
      const ids = DEMO_TRACKED_NUMBERS.map((n) => n.id);
      expect(ids).toContain(ev.properties!.tracked_number_id);
    }
  });

  it('maps to_number to one of the demo tracked numbers', () => {
    const events = generateVoipCalls(baseConfig);
    const e164s = DEMO_TRACKED_NUMBERS.map((n) => n.e164);
    for (const ev of events) {
      expect(e164s).toContain(ev.properties!.to_number);
    }
  });

  it('uses VoIP pseudo-session and stable externalId', () => {
    const events = generateVoipCalls(baseConfig);
    const externalIds = new Set<string>();
    for (const ev of events) {
      expect(ev.session_id).toMatch(/^voip:(ovh|telnyx):demo-call-\d{4}$/);
      const externalId = ev.properties!.external_id;
      expect(externalId).toMatch(/^demo-call-\d{4}$/);
      externalIds.add(externalId);
    }
    // All externalIds must be unique within a generation pass
    expect(externalIds.size).toBe(30);
  });

  it('writes a dedup_token following the staminads convention', () => {
    const events = generateVoipCalls(baseConfig);
    for (const ev of events) {
      expect(ev.dedup_token).toMatch(
        /^voip:(ovh|telnyx):demo-call-\d{4}_goal_phone_call_\d+$/,
      );
    }
  });

  it('distributes events within the requested daysRange (business days)', () => {
    const events = generateVoipCalls(baseConfig);
    const start = new Date(baseConfig.endDate);
    start.setDate(start.getDate() - baseConfig.daysRange - 1);
    for (const ev of events) {
      const eventDate = new Date(ev.received_at.replace(' ', 'T') + 'Z');
      expect(eventDate.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(eventDate.getTime()).toBeLessThanOrEqual(
        baseConfig.endDate.getTime(),
      );
    }
  });

  it('writes goal_value = duration_sec for answered calls', () => {
    const events = generateVoipCalls({ ...baseConfig, callCount: 100 });
    for (const ev of events) {
      const durationProp = parseInt(ev.properties!.duration_sec, 10);
      expect(ev.goal_value).toBe(durationProp);
    }
  });

  it('uses inbound direction and FR country for all events', () => {
    const events = generateVoipCalls(baseConfig);
    for (const ev of events) {
      expect(ev.properties!.direction).toBe('inbound');
      expect(ev.country).toBe('FR');
      expect(ev.language).toBe('fr-FR');
      expect(ev.timezone).toBe('Europe/Paris');
    }
  });

  it('sets workspace_id on every event', () => {
    const events = generateVoipCalls({ ...baseConfig, workspaceId: 'my-ws' });
    for (const ev of events) {
      expect(ev.workspace_id).toBe('my-ws');
    }
  });

  it('produces events sorted ascending by received_at', () => {
    const events = generateVoipCalls(baseConfig);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].received_at >= events[i - 1].received_at).toBe(true);
    }
  });

  it('produces an empty array when callCount=0', () => {
    const events = generateVoipCalls({ ...baseConfig, callCount: 0 });
    expect(events).toEqual([]);
  });
});
