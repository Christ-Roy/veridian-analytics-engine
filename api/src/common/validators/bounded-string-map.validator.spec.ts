import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { IsOptional } from 'class-validator';
import {
  IsBoundedStringMap,
  MAX_MAP_KEYS,
  MAX_MAP_KEY_LENGTH,
  MAX_MAP_VALUE_LENGTH,
} from './bounded-string-map.validator';

class TestDto {
  @IsOptional()
  @IsBoundedStringMap()
  map?: unknown;
}

function validate(map: unknown): boolean {
  const dto = new TestDto();
  dto.map = map;
  const errors = validateSync(dto);
  return errors.length === 0;
}

describe('IsBoundedStringMap', () => {
  it('accepts undefined / null (optional)', () => {
    expect(validate(undefined)).toBe(true);
    expect(validate(null)).toBe(true);
  });

  it('accepts a small flat string map', () => {
    expect(validate({ plan: 'pro', source: 'ads' })).toBe(true);
  });

  it('accepts scalar number/boolean values within length bound', () => {
    expect(validate({ amount: 42, active: true })).toBe(true);
  });

  it('rejects more than MAX_MAP_KEYS keys', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i <= MAX_MAP_KEYS; i++) big[`k${i}`] = 'v';
    expect(Object.keys(big).length).toBeGreaterThan(MAX_MAP_KEYS);
    expect(validate(big)).toBe(false);
  });

  it('accepts exactly MAX_MAP_KEYS keys', () => {
    const ok: Record<string, string> = {};
    for (let i = 0; i < MAX_MAP_KEYS; i++) ok[`k${i}`] = 'v';
    expect(validate(ok)).toBe(true);
  });

  it('rejects an over-long key', () => {
    expect(validate({ ['x'.repeat(MAX_MAP_KEY_LENGTH + 1)]: 'v' })).toBe(false);
  });

  it('rejects an over-long value', () => {
    expect(validate({ k: 'v'.repeat(MAX_MAP_VALUE_LENGTH + 1) })).toBe(false);
  });

  it('rejects nested objects (depth)', () => {
    expect(validate({ k: { nested: 'deep' } })).toBe(false);
  });

  it('rejects nested arrays', () => {
    expect(validate({ k: ['a', 'b'] })).toBe(false);
  });

  it('rejects arrays at top level', () => {
    expect(validate(['a', 'b'])).toBe(false);
  });

  it('rejects primitives at top level', () => {
    expect(validate('string')).toBe(false);
    expect(validate(42)).toBe(false);
  });
});
