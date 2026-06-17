import { normalizeTelnyxCdr } from './telnyx';
import { normalizeOvhConsumption } from './ovh';

describe('normalizeTelnyxCdr', () => {
  it('maps a completed inbound CDR', () => {
    const n = normalizeTelnyxCdr({
      id: 'cdr-1',
      record_type: 'cdr',
      direction: 'inbound',
      from: '+33612345678',
      to: '+33177123456',
      duration: '142',
      status: 'completed',
      started_at: '2026-06-10T09:30:00Z',
    });
    expect(n).not.toBeNull();
    expect(n!.externalId).toBe('cdr-1');
    expect(n!.direction).toBe('inbound');
    expect(n!.durationSec).toBe(142);
    expect(n!.status).toBe('answered');
  });

  it('maps no-answer to missed and outbound direction', () => {
    const n = normalizeTelnyxCdr({
      id: 'cdr-2',
      direction: 'outbound',
      duration: 0,
      status: 'no-answer',
    });
    expect(n!.direction).toBe('outbound');
    expect(n!.status).toBe('missed');
  });

  it('returns null without an id', () => {
    expect(normalizeTelnyxCdr({ direction: 'inbound' })).toBeNull();
  });

  it('extracts the first recording url when present', () => {
    const n = normalizeTelnyxCdr({
      id: 'cdr-3',
      recording_urls: ['https://rec/a.mp3', 'https://rec/b.mp3'],
    });
    expect(n!.recordingUrl).toBe('https://rec/a.mp3');
  });
});

describe('normalizeOvhConsumption', () => {
  it('maps an answered incoming consumption', () => {
    const n = normalizeOvhConsumption({
      consumptionId: 9876,
      wayType: 'incoming',
      calling: '+33612345678',
      called: '+33177123456',
      duration: 90,
      creationDatetime: '2026-06-10T10:00:00Z',
    });
    expect(n!.externalId).toBe('9876');
    expect(n!.direction).toBe('inbound');
    expect(n!.status).toBe('answered');
    expect(n!.durationSec).toBe(90);
  });

  it('maps duration 0 to missed and outgoing to outbound', () => {
    const n = normalizeOvhConsumption({
      consumptionId: 1,
      wayType: 'outgoing',
      duration: 0,
    });
    expect(n!.direction).toBe('outbound');
    expect(n!.status).toBe('missed');
  });

  it('returns null without a consumptionId', () => {
    expect(normalizeOvhConsumption({ wayType: 'incoming' })).toBeNull();
  });
});
