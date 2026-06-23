import {
  isValidOrderDirection,
  normalizeOrderDirection,
} from './order-direction.util';

describe('isValidOrderDirection', () => {
  it('accepts asc/desc (case-insensitive)', () => {
    expect(isValidOrderDirection('asc')).toBe(true);
    expect(isValidOrderDirection('desc')).toBe(true);
    expect(isValidOrderDirection('ASC')).toBe(true);
    expect(isValidOrderDirection('Desc')).toBe(true);
  });

  it('rejects SQL injection payloads', () => {
    expect(isValidOrderDirection('ASC, (SELECT 1)')).toBe(false);
    expect(isValidOrderDirection('asc; DROP TABLE sessions')).toBe(false);
    expect(isValidOrderDirection('asc--')).toBe(false);
  });

  it('rejects non-string / unknown values', () => {
    expect(isValidOrderDirection('ascending')).toBe(false);
    expect(isValidOrderDirection('')).toBe(false);
    expect(isValidOrderDirection(undefined)).toBe(false);
    expect(isValidOrderDirection(null)).toBe(false);
    expect(isValidOrderDirection(1)).toBe(false);
  });
});

describe('normalizeOrderDirection', () => {
  it('maps to fixed SQL keyword', () => {
    expect(normalizeOrderDirection('asc')).toBe('ASC');
    expect(normalizeOrderDirection('desc')).toBe('DESC');
    expect(normalizeOrderDirection('DESC')).toBe('DESC');
  });

  it('throws on injection payload instead of interpolating it', () => {
    expect(() => normalizeOrderDirection('ASC, (SELECT 1)')).toThrow(
      /Invalid order direction/,
    );
    expect(() => normalizeOrderDirection('asc; DROP TABLE')).toThrow(
      /Invalid order direction/,
    );
  });

  it('throws on non-string', () => {
    expect(() => normalizeOrderDirection(undefined)).toThrow(
      /Invalid order direction/,
    );
  });
});
