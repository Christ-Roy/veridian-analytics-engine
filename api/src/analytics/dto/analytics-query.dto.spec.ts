import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AnalyticsQueryDto } from './analytics-query.dto';

/**
 * Security regression specs for OWASP A03 (SQL injection) on the two fields
 * that were interpolated raw into ClickHouse SQL:
 *  - `timezone`  → query-builder granularity literals (P0)
 *  - `order`     → query-builder ORDER BY direction   (P1)
 *
 * These assert the DTO REJECTS injection payloads at the API boundary (400),
 * before they can ever reach the query-builder.
 */
describe('AnalyticsQueryDto — timezone validation (SQL injection guard)', () => {
  const base = {
    workspace_id: 'test-ws',
    metrics: ['sessions'],
    dateRange: { start: '2025-12-01', end: '2025-12-28', granularity: 'day' },
  };

  async function errorsFor(timezone: unknown) {
    const dto = plainToInstance(AnalyticsQueryDto, { ...base, timezone });
    return validate(dto);
  }

  it('rejects the canonical injection payload', async () => {
    const errors = await errorsFor("UTC') OR 1=1 -- ");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'timezone')).toBe(true);
  });

  it('rejects other malformed / malicious timezones', async () => {
    for (const tz of [
      "UTC'); DROP TABLE sessions; --",
      'UTC; SELECT 1',
      'Foo/Bar',
      '',
    ]) {
      const errors = await errorsFor(tz);
      expect(errors.some((e) => e.property === 'timezone')).toBe(true);
    }
  });

  it('accepts valid IANA timezones (incl. UTC alias)', async () => {
    for (const tz of ['Europe/Paris', 'UTC', 'America/New_York']) {
      const errors = await errorsFor(tz);
      expect(errors.some((e) => e.property === 'timezone')).toBe(false);
    }
  });

  it('accepts omitted timezone (optional)', async () => {
    const dto = plainToInstance(AnalyticsQueryDto, base);
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'timezone')).toBe(false);
  });
});

describe('AnalyticsQueryDto — order direction validation (SQL injection guard)', () => {
  const base = {
    workspace_id: 'test-ws',
    metrics: ['sessions'],
    dateRange: { start: '2025-12-01', end: '2025-12-28' },
  };

  async function errorsFor(order: unknown) {
    const dto = plainToInstance(AnalyticsQueryDto, { ...base, order });
    return validate(dto);
  }

  it('rejects an injected direction value', async () => {
    const errors = await errorsFor({ sessions: 'ASC, (SELECT 1)' });
    expect(errors.some((e) => e.property === 'order')).toBe(true);
  });

  it('rejects mixed valid+malicious directions', async () => {
    const errors = await errorsFor({
      sessions: 'asc',
      bounce_rate: 'desc; DROP TABLE sessions',
    });
    expect(errors.some((e) => e.property === 'order')).toBe(true);
  });

  it('accepts asc/desc (case-insensitive)', async () => {
    const errors = await errorsFor({ sessions: 'asc', bounce_rate: 'DESC' });
    expect(errors.some((e) => e.property === 'order')).toBe(false);
  });

  it('rejects a non-object order', async () => {
    const errors = await errorsFor('asc');
    expect(errors.some((e) => e.property === 'order')).toBe(true);
  });
});
