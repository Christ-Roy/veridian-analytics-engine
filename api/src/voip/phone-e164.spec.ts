import { toE164 } from './phone-e164';

describe('toE164', () => {
  it('returns null for empty / nullish input', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
  });

  it('passes through already-E.164 numbers (with cleanup)', () => {
    expect(toE164('+33177123456')).toBe('+33177123456');
    expect(toE164('+33 1 77 12 34 56')).toBe('+33177123456');
    expect(toE164('+1 (212) 555-0100')).toBe('+12125550100');
  });

  it('maps 00 international prefix to +', () => {
    expect(toE164('0033177123456')).toBe('+33177123456');
    expect(toE164('00 33 1 77 12 34 56')).toBe('+33177123456');
  });

  it('maps 10-digit FR national (leading 0) to +33', () => {
    expect(toE164('0177123456')).toBe('+33177123456');
    expect(toE164('06 12 34 56 78')).toBe('+33612345678');
    expect(toE164('01.77.12.34.56')).toBe('+33177123456');
  });

  it('maps 9-digit FR (no leading 0) to +33', () => {
    expect(toE164('177123456')).toBe('+33177123456');
    expect(toE164('612345678')).toBe('+33612345678');
  });

  it('returns null for non-normalizable input', () => {
    expect(toE164('hello')).toBeNull();
    expect(toE164('12345')).toBeNull(); // too short
    expect(toE164('0012345')).toBeNull(); // 00 but too short
  });

  it('is idempotent on its own output', () => {
    const once = toE164('06 12 34 56 78');
    expect(once).toBe('+33612345678');
    expect(toE164(once)).toBe('+33612345678');
  });
});
