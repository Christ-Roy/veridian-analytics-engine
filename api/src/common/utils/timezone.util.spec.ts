import { isValidTimezone, assertValidTimezone } from './timezone.util';

describe('isValidTimezone', () => {
  it('accepts canonical IANA zones', () => {
    expect(isValidTimezone('Europe/Paris')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
  });

  it('accepts legacy aliases (UTC, GMT) that supportedValuesOf omits', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('GMT')).toBe(true);
    expect(isValidTimezone('Etc/UTC')).toBe(true);
  });

  it('rejects SQL injection payloads', () => {
    expect(isValidTimezone("UTC') OR 1=1 -- ")).toBe(false);
    expect(isValidTimezone("UTC'); DROP TABLE sessions; --")).toBe(false);
    expect(isValidTimezone('UTC; SELECT 1')).toBe(false);
    expect(isValidTimezone("'")).toBe(false);
  });

  it('rejects non-existent or malformed zones', () => {
    expect(isValidTimezone('Foo/Bar')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Europe/Paris ')).toBe(false); // trailing space
  });

  it('rejects non-string input', () => {
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
    expect(isValidTimezone({})).toBe(false);
  });
});

describe('assertValidTimezone', () => {
  it('passes silently for valid IANA zones', () => {
    expect(() => assertValidTimezone('Europe/Paris')).not.toThrow();
    expect(() => assertValidTimezone('UTC')).not.toThrow();
  });

  it('throws on injection payload', () => {
    expect(() => assertValidTimezone("UTC') OR 1=1 -- ")).toThrow(
      /Invalid IANA timezone/,
    );
  });

  it('throws on malformed zone', () => {
    expect(() => assertValidTimezone('Foo/Bar')).toThrow(/Invalid IANA timezone/);
  });
});
