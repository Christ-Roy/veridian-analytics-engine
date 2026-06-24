import { ConfigService } from '@nestjs/config';

// Mock the ClickHouse client factory so we can assert the options we pass to
// createClient WITHOUT opening a real connection. The service builds the client
// in its constructor, so we only need to inspect the first call's argument.
const createClientMock = jest.fn(() => ({
  close: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@clickhouse/client', () => ({
  createClient: (opts: unknown) => createClientMock(opts),
}));

// Imported AFTER the mock is registered.
import { ClickHouseService } from './clickhouse.service';

/** Minimal ConfigService stub driven by a plain env map. */
function configFrom(env: Record<string, string | undefined>): ConfigService {
  return {
    get: <T = string>(key: string, def?: T): T =>
      (env[key] as unknown as T) ?? (def as T),
  } as unknown as ConfigService;
}

/** Grab the options object passed to the most recent createClient() call. */
function lastClientOptions(): Record<string, unknown> {
  const calls = createClientMock.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

describe('ClickHouseService — connection timeouts (scale guard)', () => {
  beforeEach(() => {
    createClientMock.mockClear();
  });

  it('applies sane DEFAULT timeouts when no ENV is set', () => {
    // No CLICKHOUSE_MAX_EXECUTION_TIME / CLICKHOUSE_REQUEST_TIMEOUT_MS.
    new ClickHouseService(configFrom({}));

    const opts = lastClientOptions();
    // request_timeout (ms) bounds the client HTTP wait so a hung query can't
    // pin a pool connection forever.
    expect(opts.request_timeout).toBe(60_000);
    // max_execution_time (s) makes the SERVER kill a runaway aggregation first.
    expect(opts.clickhouse_settings).toEqual(
      expect.objectContaining({ max_execution_time: 30 }),
    );
    // request_timeout must exceed max_execution_time so the server kills first.
    expect(opts.request_timeout as number).toBeGreaterThan(
      (opts.clickhouse_settings as { max_execution_time: number })
        .max_execution_time * 1000,
    );
  });

  it('honours ENV overrides for both timeouts', () => {
    new ClickHouseService(
      configFrom({
        CLICKHOUSE_MAX_EXECUTION_TIME: '45',
        CLICKHOUSE_REQUEST_TIMEOUT_MS: '90000',
      }),
    );

    const opts = lastClientOptions();
    expect(opts.request_timeout).toBe(90_000);
    expect(opts.clickhouse_settings).toEqual(
      expect.objectContaining({ max_execution_time: 45 }),
    );
  });

  it('falls back to defaults when ENV values are non-numeric / non-positive', () => {
    new ClickHouseService(
      configFrom({
        CLICKHOUSE_MAX_EXECUTION_TIME: 'abc',
        CLICKHOUSE_REQUEST_TIMEOUT_MS: '0',
      }),
    );

    const opts = lastClientOptions();
    expect(opts.request_timeout).toBe(60_000);
    expect(opts.clickhouse_settings).toEqual(
      expect.objectContaining({ max_execution_time: 30 }),
    );
  });
});
