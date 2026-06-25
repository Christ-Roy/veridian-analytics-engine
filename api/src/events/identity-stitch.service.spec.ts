import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IdentityStitchService } from './identity-stitch.service';
import { ClickHouseService } from '../database/clickhouse.service';

/**
 * Unit tests for IdentityStitchService — the JOIN-KEY priority, the "no false
 * acquisition" guard, the de-dup cache, and the fire-and-forget contract.
 *
 * The REAL stitch (against ClickHouse, with the actual fingerprint bridge proven
 * on prod data) is covered by test/identity-stitch.e2e-spec.ts. Here we mock the
 * DB to assert the orchestration logic deterministically.
 */
describe('IdentityStitchService (unit)', () => {
  let service: IdentityStitchService;
  let clickhouse: { queryWorkspace: jest.Mock; insertWorkspace: jest.Mock; commandWorkspaceWithParams: jest.Mock };
  let emitter: { emit: jest.Mock };

  const identifiedSession = {
    id: 'app-sess',
    user_id: 'jo@test.com',
    visitor_id: 'app-vid',
    fingerprint: 'fp-shared',
    created_at: '2026-06-25 10:53:29.590',
    channel: 'direct',
    channel_group: 'direct',
    referrer: '',
    referrer_domain: '',
    landing_page: 'https://app.test.com/login',
    landing_domain: 'app.test.com',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_content: '',
  };

  const vitrineSession = {
    ...identifiedSession,
    id: 'vitrine-sess',
    user_id: null,
    visitor_id: 'vitrine-vid',
    created_at: '2026-06-25 10:53:19.590',
    channel: 'organic_search',
    channel_group: 'seo',
    referrer: 'https://www.google.com/',
    referrer_domain: 'www.google.com',
    landing_page: 'https://test.com/',
    landing_domain: 'test.com',
  };

  beforeEach(async () => {
    clickhouse = {
      queryWorkspace: jest.fn(),
      insertWorkspace: jest.fn().mockResolvedValue(undefined),
      commandWorkspaceWithParams: jest.fn().mockResolvedValue(undefined),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityStitchService,
        { provide: ClickHouseService, useValue: clickhouse },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(IdentityStitchService);
  });

  afterEach(() => jest.clearAllMocks());

  it('stitches first-touch from the fingerprint chain when session_id/visitor_id miss', async () => {
    // 1st query: identified session. Then findFirstTouch tries session_id (miss),
    // visitor_id (miss), fingerprint (hit → vitrine session).
    clickhouse.queryWorkspace
      .mockResolvedValueOnce([identifiedSession]) // getIdentifiedSession
      .mockResolvedValueOnce([]) // session_id chain
      .mockResolvedValueOnce([]) // visitor_id chain
      .mockResolvedValueOnce([vitrineSession]); // fingerprint chain

    const method = await service.stitch('ws1', 'jo@test.com');

    expect(method).toBe('fingerprint');

    // user_attribution upsert carries the vitrine first-touch + the login last-touch.
    expect(clickhouse.insertWorkspace).toHaveBeenCalledWith(
      'ws1',
      'user_attribution',
      [
        expect.objectContaining({
          identity_key: 'jo@test.com',
          first_touch_channel: 'organic_search',
          first_touch_channel_group: 'seo',
          first_touch_method: 'fingerprint',
          last_touch_channel_group: 'direct',
        }),
      ],
    );

    // Denormalized onto sessions + goals (2 UPDATE mutations).
    expect(clickhouse.commandWorkspaceWithParams).toHaveBeenCalledTimes(2);
    const tablesUpdated = clickhouse.commandWorkspaceWithParams.mock.calls.map(
      (c) => c[1],
    );
    expect(tablesUpdated.some((q: string) => q.includes('ALTER TABLE sessions'))).toBe(true);
    expect(tablesUpdated.some((q: string) => q.includes('ALTER TABLE goals'))).toBe(true);

    // Cache invalidated.
    expect(emitter.emit).toHaveBeenCalledWith('backfill.completed', {
      workspaceId: 'ws1',
    });
  });

  it('prefers the strongest key: visitor_id wins over fingerprint', async () => {
    clickhouse.queryWorkspace
      .mockResolvedValueOnce([identifiedSession]) // identified
      .mockResolvedValueOnce([]) // session_id miss
      .mockResolvedValueOnce([{ ...vitrineSession, channel_group: 'ads', channel: 'paid_search' }]); // visitor_id HIT

    const method = await service.stitch('ws1', 'jo@test.com');

    expect(method).toBe('visitor_id');
    // fingerprint chain NOT queried (only 3 queries: identified + session_id + visitor_id).
    expect(clickhouse.queryWorkspace).toHaveBeenCalledTimes(3);
    expect(clickhouse.insertWorkspace).toHaveBeenCalledWith(
      'ws1',
      'user_attribution',
      [expect.objectContaining({ first_touch_channel_group: 'ads', first_touch_method: 'visitor_id' })],
    );
  });

  it('invents NO acquisition when no chain resolves (returns null, no write)', async () => {
    clickhouse.queryWorkspace
      .mockResolvedValueOnce([identifiedSession]) // identified
      .mockResolvedValueOnce([]) // session_id miss
      .mockResolvedValueOnce([]) // visitor_id miss
      .mockResolvedValueOnce([]); // fingerprint miss

    const method = await service.stitch('ws1', 'jo@test.com');

    expect(method).toBeNull();
    expect(clickhouse.insertWorkspace).not.toHaveBeenCalled();
    expect(clickhouse.commandWorkspaceWithParams).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('returns null when the user has no identified session', async () => {
    clickhouse.queryWorkspace.mockResolvedValueOnce([]); // no identified session

    const method = await service.stitch('ws1', 'ghost@test.com');
    expect(method).toBeNull();
    expect(clickhouse.queryWorkspace).toHaveBeenCalledTimes(1);
  });

  it('scheduleStitch is fire-and-forget: never throws even if the DB blows up', async () => {
    clickhouse.queryWorkspace.mockRejectedValue(new Error('CH down'));
    // Must not throw synchronously nor reject into the caller.
    expect(() => service.scheduleStitch('ws1', 'jo@test.com')).not.toThrow();
    // Let the microtask settle.
    await new Promise((r) => setTimeout(r, 10));
  });

  it('scheduleStitch de-dups: a second call within the TTL does not re-query', async () => {
    clickhouse.queryWorkspace.mockResolvedValue([]); // no identified session
    service.scheduleStitch('ws1', 'jo@test.com');
    await new Promise((r) => setTimeout(r, 10));
    const callsAfterFirst = clickhouse.queryWorkspace.mock.calls.length;

    service.scheduleStitch('ws1', 'jo@test.com');
    await new Promise((r) => setTimeout(r, 10));
    // Second call short-circuited by the cache (it succeeded, so cache kept).
    expect(clickhouse.queryWorkspace.mock.calls.length).toBe(callsAfterFirst);
  });
});
