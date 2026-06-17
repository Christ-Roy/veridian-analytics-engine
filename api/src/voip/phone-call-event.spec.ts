import { buildPhoneCallEvent } from './phone-call-event';
import { NormalizedCall } from './voip.types';

const baseCall: NormalizedCall = {
  externalId: 'call-123',
  direction: 'inbound',
  fromNumber: '+33612345678',
  toNumber: '+33177123456',
  durationSec: 142,
  status: 'answered',
  recordingUrl: null,
  startedAt: new Date('2026-06-10T09:30:00.000Z'),
};

describe('buildPhoneCallEvent', () => {
  it('produces a goal event with the phone_call contract', () => {
    const ev = buildPhoneCallEvent('ws_1', 'ovh', baseCall, null);
    expect(ev.name).toBe('goal');
    expect(ev.goal_name).toBe('phone_call');
    expect(ev.goal_value).toBe(142);
    expect(ev.workspace_id).toBe('ws_1');
    // pseudo-session VoIP, deterministic
    expect(ev.session_id).toBe('voip:ovh:call-123');
  });

  it('embeds call metadata in properties', () => {
    const ev = buildPhoneCallEvent('ws_1', 'telnyx', baseCall, null);
    expect(ev.properties).toMatchObject({
      direction: 'inbound',
      duration_sec: '142',
      status: 'answered',
      from_number: '+33612345678',
      to_number: '+33177123456',
      provider: 'telnyx',
      external_id: 'call-123',
      source: 'direct', // no match → safe default
    });
    expect(ev.referrer).toBe('voip://telnyx');
  });

  it('attributes the source from a lookup match', () => {
    const ev = buildPhoneCallEvent('ws_1', 'ovh', baseCall, {
      source: 'seo',
      id: 'phn_x',
      label: 'Ligne SEO',
    });
    expect(ev.properties?.source).toBe('seo');
    expect(ev.properties?.tracked_number_id).toBe('phn_x');
    expect(ev.properties?.tracked_number_label).toBe('Ligne SEO');
  });

  it('includes recording_url only when present', () => {
    const without = buildPhoneCallEvent('ws_1', 'ovh', baseCall, null);
    expect(without.properties?.recording_url).toBeUndefined();
    const withRec = buildPhoneCallEvent(
      'ws_1',
      'ovh',
      { ...baseCall, recordingUrl: 'https://rec/abc.mp3' },
      null,
    );
    expect(withRec.properties?.recording_url).toBe('https://rec/abc.mp3');
  });

  it('uses a deterministic dedup_token (idempotent re-sync)', () => {
    const a = buildPhoneCallEvent('ws_1', 'ovh', baseCall, null);
    const b = buildPhoneCallEvent('ws_1', 'ovh', baseCall, null);
    expect(a.dedup_token).toBe(b.dedup_token);
    expect(a.dedup_token).toContain('voip:ovh:call-123_goal_phone_call_');
  });
});
