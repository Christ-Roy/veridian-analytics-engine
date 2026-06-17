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
      },
    ]);
    voip.buildSourceLookup.mockResolvedValue(
      new Map([['+33177123456', { source: 'seo', id: 'phn_x', label: 'SEO' }]]),
    );
    mockedOvh.fetchOvhCdr.mockResolvedValue([sampleCall]);

    await sync.syncAll();

    expect(added[0].properties?.source).toBe('seo');
    expect(added[0].properties?.tracked_number_id).toBe('phn_x');
  });

  it('records an error without aborting other credentials', async () => {
    const { sync, voip } = makeHarness(true);
    voip.findAllActiveCredentials.mockResolvedValue([
      { workspaceId: 'ws_bad', kind: 'voip_ovh', creds: {} as never },
      {
        workspaceId: 'ws_ok',
        kind: 'voip_telnyx',
        creds: { apiKey: 'KEYaaaabbbbcccc' } as never,
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
      },
    ]);
    mockedTelnyx.fetchTelnyxCdr.mockResolvedValue([]);
    const res = await sync.syncAll();
    expect(res.pushedEvents).toBe(0);
    expect(added).toHaveLength(0);
  });
});
