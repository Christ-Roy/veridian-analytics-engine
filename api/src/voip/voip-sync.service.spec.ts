import { ConfigService } from '@nestjs/config';
import { EventBufferService } from '../events/event-buffer.service';
import { TrackingEvent } from '../events/entities/event.entity';
import { VoipService } from './voip.service';
import { VoipSyncService } from './voip-sync.service';
import { NormalizedCall } from './voip.types';
import * as ovh from './providers/ovh';
import * as telnyx from './providers/telnyx';

jest.mock('./providers/ovh');
jest.mock('./providers/telnyx');

const mockedOvh = ovh as jest.Mocked<typeof ovh>;
const mockedTelnyx = telnyx as jest.Mocked<typeof telnyx>;

const sampleCall: NormalizedCall = {
  externalId: 'c1',
  direction: 'inbound',
  fromNumber: '+33612345678',
  toNumber: '+33177123456',
  durationSec: 90,
  status: 'answered',
  recordingUrl: null,
  startedAt: new Date('2026-06-10T10:00:00.000Z'),
};

function makeHarness(syncEnabled: boolean) {
  const added: TrackingEvent[] = [];
  const events = {
    addBatch: jest.fn(async (batch: TrackingEvent[]) => {
      added.push(...batch);
    }),
    flush: jest.fn(async () => {}),
  } as unknown as EventBufferService;

  const voip = {
    findAllActiveCredentials: jest.fn(),
    buildSourceLookup: jest.fn(async () => new Map()),
    providerOf: jest.fn((kind: string) =>
      kind === 'voip_ovh' ? 'ovh' : 'telnyx',
    ),
    markSynced: jest.fn(async () => {}),
    markSyncError: jest.fn(async () => {}),
  } as unknown as jest.Mocked<VoipService>;

  const config = {
    get: (key: string) =>
      key === 'VOIP_SYNC_ENABLED' ? (syncEnabled ? 'true' : 'false') : undefined,
  } as unknown as ConfigService;

  const sync = new VoipSyncService(voip, events, config);
  return { sync, voip, events, added };
}

describe('VoipSyncService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing on the cron when VOIP_SYNC_ENABLED != true', async () => {
    const { sync, voip } = makeHarness(false);
    await sync.scheduledSync();
    expect(voip.findAllActiveCredentials).not.toHaveBeenCalled();
  });

  it('pulls Telnyx CDR and pushes phone_call events internally', async () => {
    const { sync, voip, added } = makeHarness(true);
    voip.findAllActiveCredentials.mockResolvedValue([
      {
        workspaceId: 'ws_1',
        kind: 'voip_telnyx',
        creds: { apiKey: 'KEYaaaabbbbcccc' } as never,
        lastSyncAt: null,
      },
    ]);
    mockedTelnyx.fetchTelnyxCdr.mockResolvedValue([sampleCall]);

    const res = await sync.syncAll();

    expect(mockedTelnyx.fetchTelnyxCdr).toHaveBeenCalledTimes(1);
    expect(res.pushedEvents).toBe(1);
    expect(added).toHaveLength(1);
    expect(added[0].goal_name).toBe('phone_call');
    expect(added[0].properties?.provider).toBe('telnyx');
    expect(voip.markSynced).toHaveBeenCalledWith('ws_1', 'voip_telnyx');
  });

  it('attributes source via the workspace lookup', async () => {
    const { sync, voip, added } = makeHarness(true);
    voip.findAllActiveCredentials.mockResolvedValue([
      {
        workspaceId: 'ws_1',
        kind: 'voip_ovh',
        creds: {
          applicationKey: 'a',
          applicationSecret: 'b',
          consumerKey: 'c',
          endpoint: 'ovh-eu',
        } as never,
        lastSyncAt: null,
      },
    ]);
    voip.buildSourceLookup.mockResolvedValue(
      new Map([['+33177123456', { source: 'seo', id: 'phn_x', label: 'SEO' }]]),
    );
    mockedOvh.fetchOvhCdr.mockResolvedValue([sampleCall]);

    await sync.syncAll();

    expect(added[0].properties?.source).toBe('seo');
    expect(added[0].properties?.tracked_number_id).toBe('phn_x');
    expect(added[0].properties?.source_attributed).toBe('true');
  });

  it('records an error without aborting other credentials', async () => {
    const { sync, voip } = makeHarness(true);
    voip.findAllActiveCredentials.mockResolvedValue([
      {
        workspaceId: 'ws_bad',
        kind: 'voip_ovh',
        creds: {} as never,
        lastSyncAt: null,
      },
      {
        workspaceId: 'ws_ok',
        kind: 'voip_telnyx',
        creds: { apiKey: 'KEYaaaabbbbcccc' } as never,
        lastSyncAt: null,
      },
    ]);
    mockedOvh.fetchOvhCdr.mockRejectedValue(new Error('ovh boom'));
    mockedTelnyx.fetchTelnyxCdr.mockResolvedValue([sampleCall]);

    const res = await sync.syncAll();

    expect(voip.markSyncError).toHaveBeenCalledWith(
      'ws_bad',
      'voip_ovh',
      'ovh boom',
    );
    expect(voip.markSynced).toHaveBeenCalledWith('ws_ok', 'voip_telnyx');
    expect(res.pushedEvents).toBe(1);
  });

  it('pushes nothing when there are no calls', async () => {
    const { sync, voip, added } = makeHarness(true);
    voip.findAllActiveCredentials.mockResolvedValue([
      {
        workspaceId: 'ws_1',
        kind: 'voip_telnyx',
        creds: { apiKey: 'KEYaaaabbbbcccc' } as never,
        lastSyncAt: null,
      },
    ]);
    mockedTelnyx.fetchTelnyxCdr.mockResolvedValue([]);
    const res = await sync.syncAll();
    expect(res.pushedEvents).toBe(0);
    expect(added).toHaveLength(0);
  });

  it('always releases the `running` flag even when a provider fetch throws', async () => {
    const { sync, voip } = makeHarness(true);
    voip.findAllActiveCredentials.mockResolvedValue([
      {
        workspaceId: 'ws_1',
        kind: 'voip_ovh',
        creds: {} as never,
        lastSyncAt: null,
      },
    ]);
    // Simulate a provider that explodes (timeout/abort surfaces as a throw too).
    mockedOvh.fetchOvhCdr.mockRejectedValue(new Error('frozen fetch'));

    // First run: provider fails, the per-cred catch records the error.
    await sync.syncAll();
    // Second run MUST proceed (flag was released) — if `running` had stuck at
    // true, this call would early-return without touching the providers.
    mockedOvh.fetchOvhCdr.mockClear();
    mockedOvh.fetchOvhCdr.mockResolvedValue([sampleCall]);
    const res = await sync.syncAll();

    expect(mockedOvh.fetchOvhCdr).toHaveBeenCalledTimes(1);
    expect(res.pushedEvents).toBe(1);
  });

  it('uses an incremental window from lastSyncAt (pulls less than the 7d floor)', async () => {
    // Le window = max(lastSyncAt - overlap(2d), now - floor(7d)). Pour prouver
    // que c'est bien la branche INCRÉMENTALE qui gagne, on fige l'horloge à un
    // instant où `lastSyncAt - 2d` est PLUS RÉCENT que `now - 7d`. Sans gel,
    // ce test devenait rouge dès que le wall-clock dépassait lastSyncAt+5j
    // (le floor 7d rattrapait l'incrémental) — flake temporel pré-existant
    // sans rapport avec la logique de prod (le clamp 7d est correct).
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-20T12:00:00.000Z'));
    try {
      const { sync, voip } = makeHarness(true);
      const lastSyncAt = new Date('2026-06-20T12:00:00.000Z');
      voip.findAllActiveCredentials.mockResolvedValue([
        {
          workspaceId: 'ws_1',
          kind: 'voip_telnyx',
          creds: { apiKey: 'KEYaaaabbbbcccc' } as never,
          lastSyncAt,
        },
      ]);
      mockedTelnyx.fetchTelnyxCdr.mockResolvedValue([]);

      await sync.syncAll();

      const opts = mockedTelnyx.fetchTelnyxCdr.mock.calls[0][1];
      // now - 7d = 2026-06-13 ; lastSyncAt - overlap(2d) = 2026-06-18 → incrémental gagne.
      expect(opts.since.toISOString()).toBe('2026-06-18T12:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to the default 7d lookback when never synced', async () => {
    const { sync, voip } = makeHarness(true);
    voip.findAllActiveCredentials.mockResolvedValue([
      {
        workspaceId: 'ws_1',
        kind: 'voip_telnyx',
        creds: { apiKey: 'KEYaaaabbbbcccc' } as never,
        lastSyncAt: null,
      },
    ]);
    mockedTelnyx.fetchTelnyxCdr.mockResolvedValue([]);

    const before = Date.now();
    await sync.syncAll();
    const after = Date.now();

    const opts = mockedTelnyx.fetchTelnyxCdr.mock.calls[0][1];
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // since ≈ now - 7d (allow the test's own wall-clock jitter)
    expect(opts.since.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs - 50);
    expect(opts.since.getTime()).toBeLessThanOrEqual(after - sevenDaysMs + 50);
  });

  it('warns about unmapped called numbers (attribution visibility)', async () => {
    const { sync, voip } = makeHarness(true);
    const warn = jest
      .spyOn((sync as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => {});
    voip.findAllActiveCredentials.mockResolvedValue([
      {
        workspaceId: 'ws_1',
        kind: 'voip_telnyx',
        creds: { apiKey: 'KEYaaaabbbbcccc' } as never,
        lastSyncAt: null,
      },
    ]);
    // No source lookup entry → the called number is unmapped.
    voip.buildSourceLookup.mockResolvedValue(new Map());
    mockedTelnyx.fetchTelnyxCdr.mockResolvedValue([sampleCall]);

    await sync.syncAll();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('non mappé');
    expect(warn.mock.calls[0][0]).toContain('+33177123456');
  });
});
