import { stripUndefined } from './strip-undefined.util';

describe('stripUndefined', () => {
  it('drops keys whose value is strictly undefined', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: 3 })).toEqual({ a: 1, c: 3 });
  });

  it('PRESERVES false / 0 / empty string / null (deliberate values)', () => {
    // This is the crux of the setFeatures fix: `false` is a meaningful flag
    // value and must NOT be treated like "unset".
    expect(
      stripUndefined({ voip: false, count: 0, label: '', cleared: null }),
    ).toEqual({ voip: false, count: 0, label: '', cleared: null });
  });

  it('models the class-transformer footgun: a partial DTO instance', () => {
    // class-transformer (exposeUnsetFields default true) materialises every
    // declared field, so `{ voip: true }` becomes an instance carrying gsc and
    // connectors as own keys set to undefined. Spreading it raw over existing
    // flags would clobber them; stripUndefined keeps only what was provided.
    const transformedDto = {
      voip: true,
      gsc: undefined,
      connectors: undefined,
    };
    const existing = { voip: false, gsc: true, connectors: true };
    const merged = { ...existing, ...stripUndefined(transformedDto) };
    expect(merged).toEqual({ voip: true, gsc: true, connectors: true });
  });

  it('returns an empty object for an all-undefined input', () => {
    expect(stripUndefined({ a: undefined, b: undefined })).toEqual({});
  });

  it('does not mutate the source object', () => {
    const src = { a: 1, b: undefined };
    stripUndefined(src);
    expect(src).toEqual({ a: 1, b: undefined });
  });
});
