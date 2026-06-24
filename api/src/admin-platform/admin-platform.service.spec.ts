/**
 * Unit tests for AdminPlatformService.provisionTenant (M2M endpoint).
 *
 * Verifies the orchestration flow + compensation logic. All downstream
 * domain services are mocked — those have their own specs.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminPlatformService } from './admin-platform.service';
import { ClickHouseService } from '../database/clickhouse.service';
import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { MailService } from '../mail/mail.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { VoipService } from '../voip/voip.service';
import { VoipSyncService } from '../voip/voip-sync.service';
import { GscService } from '../gsc/gsc.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookDeliveryWorker } from '../webhooks/webhook-delivery-worker.service';
import { SsrfGuard } from '../common/ssrf-guard';

describe('AdminPlatformService.provisionTenant', () => {
  let service: AdminPlatformService;
  let clickhouse: jest.Mocked<ClickHouseService>;
  let usersService: jest.Mocked<UsersService>;
  let workspacesService: jest.Mocked<WorkspacesService>;
  let apiKeysService: jest.Mocked<ApiKeysService>;
  let mailService: jest.Mocked<MailService>;
  let configService: jest.Mocked<ConfigService>;
  let analyticsService: jest.Mocked<AnalyticsService>;
  let voipService: jest.Mocked<VoipService>;
  let voipSyncService: jest.Mocked<VoipSyncService>;
  let gscService: jest.Mocked<GscService>;
  let webhooksService: jest.Mocked<WebhooksService>;
  let webhookDeliveryWorker: jest.Mocked<WebhookDeliveryWorker>;

  /**
   * Stub DNS resolver backing the injected SsrfGuard. Mutable so individual
   * tests can repoint a hostname at a private / metadata IP. Default: every
   * hostname resolves to a public address (93.184.216.34) so the existing
   * site-snippet tests sail through the guard to the stubbed fetch.
   */
  let ssrfResolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  const PUBLIC_IP = '93.184.216.34';

  beforeEach(async () => {
    ssrfResolve = async () => [{ address: PUBLIC_IP, family: 4 }];


    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminPlatformService,
        {
          provide: ClickHouseService,
          useValue: {
            querySystem: jest.fn().mockResolvedValue([]),
            insertSystem: jest.fn().mockResolvedValue(undefined),
            queryWorkspace: jest.fn().mockResolvedValue([]),
            insertWorkspace: jest.fn().mockResolvedValue(undefined),
            commandWorkspaceWithParams: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            create: jest.fn(),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WorkspacesService,
          useValue: {
            create: jest.fn().mockResolvedValue({}),
            get: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ApiKeysService,
          useValue: {
            create: jest.fn(),
            createForPlatform: jest.fn(),
            revokeForPlatform: jest.fn(),
            listForPlatform: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: {
            sendPasswordReset: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) => {
              const env: Record<string, string | undefined> = {
                APP_URL: 'http://localhost:5173',
                TRACKER_PUBLIC_ORIGIN: 'https://tracker.example',
                BRIDGE_URL: undefined,
                BRIDGE_ADMIN_API_KEY: undefined,
              };
              return env[key] ?? def;
            }),
          },
        },
        {
          provide: AnalyticsService,
          useValue: {
            query: jest.fn().mockResolvedValue({ data: [], meta: {} }),
            funnel: jest.fn().mockResolvedValue({ steps: [] }),
            conversionsByChannel: jest.fn().mockResolvedValue({ rows: [] }),
          },
        },
        {
          provide: VoipService,
          useValue: {
            listCredentials: jest.fn().mockResolvedValue([]),
            listPhoneNumbers: jest
              .fn()
              .mockResolvedValue({ phoneNumbers: [], allowedSources: [] }),
            createPhoneNumber: jest.fn(),
            deletePhoneNumber: jest.fn(),
            saveCredential: jest.fn(),
            testCredential: jest.fn(),
            deleteCredential: jest.fn(),
          },
        },
        {
          provide: VoipSyncService,
          useValue: {
            syncAll: jest
              .fn()
              .mockResolvedValue({ syncedWorkspaces: 0, pushedEvents: 0 }),
          },
        },
        {
          provide: GscService,
          useValue: {
            status: jest.fn().mockResolvedValue({
              connected: false,
              site_url: null,
              ownership_state: null,
              last_sync_at: null,
            }),
            resync: jest.fn().mockResolvedValue({ skipped: 'not_connected' }),
          },
        },
        {
          provide: WebhooksService,
          useValue: {
            list: jest.fn().mockResolvedValue([]),
            create: jest.fn(),
            softDelete: jest.fn(),
            findById: jest.fn(),
            enqueueDelivery: jest.fn(),
            updateDelivery: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WebhookDeliveryWorker,
          useValue: {
            sendOne: jest.fn(),
          },
        },
        // SsrfGuard with a STUB resolver so verifyTracking's site probe never
        // does real DNS in tests. By default every test hostname resolves to a
        // public IP (so the existing snippet tests reach the stubbed fetch);
        // the dedicated SSRF tests below override ssrfResolve to point at
        // private / metadata addresses and assert the guard blocks them.
        {
          provide: SsrfGuard,
          useFactory: () =>
            new SsrfGuard((hostname: string) =>
              ssrfResolve(hostname),
            ),
        },
      ],
    }).compile();

    service = module.get<AdminPlatformService>(AdminPlatformService);
    clickhouse = module.get(ClickHouseService);
    usersService = module.get(UsersService);
    workspacesService = module.get(WorkspacesService);
    apiKeysService = module.get(ApiKeysService);
    mailService = module.get(MailService);
    configService = module.get(ConfigService);
    analyticsService = module.get(AnalyticsService);
    voipService = module.get(VoipService);
    voipSyncService = module.get(VoipSyncService);
    gscService = module.get(GscService);
    webhooksService = module.get(WebhooksService);
    webhookDeliveryWorker = module.get(WebhookDeliveryWorker);

    jest.clearAllMocks();
    // Re-stub after clearAllMocks
    clickhouse.querySystem.mockResolvedValue([]);
    clickhouse.insertSystem.mockResolvedValue(undefined);
    clickhouse.queryWorkspace.mockResolvedValue([]);
    clickhouse.insertWorkspace.mockResolvedValue(undefined);
    clickhouse.commandWorkspaceWithParams.mockResolvedValue(undefined);
    usersService.delete.mockResolvedValue(undefined);
    workspacesService.create.mockResolvedValue({} as never);
    mailService.sendPasswordReset.mockResolvedValue(undefined);
    // Re-stub connector defaults (cleared above) so probes have safe values.
    analyticsService.query.mockResolvedValue({ data: [], meta: {} } as never);
    voipService.listCredentials.mockResolvedValue([]);
    voipService.listPhoneNumbers.mockResolvedValue({
      phoneNumbers: [],
      allowedSources: [] as never,
    });
    voipSyncService.syncAll.mockResolvedValue({
      syncedWorkspaces: 0,
      pushedEvents: 0,
    });
    gscService.status.mockResolvedValue({
      connected: false,
      site_url: null,
      ownership_state: null,
      last_sync_at: null,
    });
    gscService.resync.mockResolvedValue({ skipped: 'not_connected' });
    webhooksService.list.mockResolvedValue([]);
    webhooksService.updateDelivery.mockResolvedValue(undefined);
    configService.get.mockImplementation((key: string, def?: unknown) => {
      const env: Record<string, string | undefined> = {
        APP_URL: 'http://localhost:5173',
        TRACKER_PUBLIC_ORIGIN: 'https://tracker.example',
        BRIDGE_URL: undefined,
        BRIDGE_ADMIN_API_KEY: undefined,
      };
      return (env[key] ?? def) as never;
    });
  });

  function happyPathStubs() {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockResolvedValue({
      id: 'user-uuid-1',
      email: 'owner@example.com',
      name: 'Boulangerie Dupont',
      status: 'active',
      created_at: '2026-05-25 10:00:00.000',
    });
    apiKeysService.create.mockResolvedValue({
      key: 'stam_live_deadbeef',
      apiKey: { id: 'apikey-1' } as never,
    });
  }

  it('rejects with 409 when email already exists', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: 'existing-user',
    } as never);

    await expect(
      service.provisionTenant({
        email: 'owner@example.com',
        siteUrl: 'https://example.com',
        name: 'Boulangerie Dupont',
      }),
    ).rejects.toThrow(ConflictException);

    expect(usersService.create).not.toHaveBeenCalled();
    expect(workspacesService.create).not.toHaveBeenCalled();
  });

  it('provisions tenant end-to-end (no phones, no bridge)', async () => {
    happyPathStubs();

    const result = await service.provisionTenant({
      email: 'owner@example.com',
      siteUrl: 'https://example.com',
      name: 'Boulangerie Dupont',
    });

    expect(usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@example.com' }),
    );
    expect(workspacesService.create).toHaveBeenCalledTimes(1);
    expect(apiKeysService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: expect.stringMatching(/^boulangerie_dupont/),
        role: 'admin',
      }),
      'user-uuid-1',
    );
    expect(mailService.sendPasswordReset).toHaveBeenCalledTimes(1);

    expect(result.api_key).toBe('stam_live_deadbeef');
    expect(result.owner_user_id).toBe('user-uuid-1');
    expect(result.workspace_id).toMatch(/^boulangerie_dupont/);
    // Snippet must point at the SDK route that actually serves the tracker
    // bundle (/sdk/v1/tracker.js), NOT the bare <origin>/tracker.js path which
    // falls through to the SPA console HTML and tracks nothing.
    expect(result.snippet_html).toContain('https://tracker.example/sdk/v1/tracker.js');
    expect(result.snippet_html).not.toContain('src="https://tracker.example/tracker.js"');
    expect(result.snippet_html).toContain(result.workspace_id);
    // Snippet must NOT leak the api_key (separation of concerns).
    expect(result.snippet_html).not.toContain('stam_live_');
    expect(result.dashboard_url).toContain(result.workspace_id);
    expect(result.password_reset_url).toContain('/reset-password/');
    expect(result.phone_numbers).toEqual([]);
    expect(result.user_created).toBe(true);
  });

  it('slugifies workspace name with accents and special chars', async () => {
    happyPathStubs();

    const result = await service.provisionTenant({
      email: 'owner@example.com',
      siteUrl: 'https://example.com',
      name: 'Café  Léon & Fils!',
    });

    expect(result.workspace_id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.workspace_id.length).toBeGreaterThanOrEqual(2);
    expect(result.workspace_id.length).toBeLessThanOrEqual(50);
  });

  it('resolves slug collisions with numeric suffix', async () => {
    happyPathStubs();
    // Simulate first slug already taken, second free.
    let call = 0;
    clickhouse.querySystem.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM workspaces')) {
        call += 1;
        if (call === 1) {
          return [{ id: 'boulangerie_dupont' }] as never;
        }
        return [] as never;
      }
      return [] as never;
    });

    const result = await service.provisionTenant({
      email: 'owner@example.com',
      siteUrl: 'https://example.com',
      name: 'Boulangerie Dupont',
    });

    expect(result.workspace_id).toBe('boulangerie_dupont_2');
  });

  it('compensates by soft-deleting user when workspace creation fails', async () => {
    happyPathStubs();
    workspacesService.create.mockRejectedValue(new Error('CH down'));

    await expect(
      service.provisionTenant({
        email: 'owner@example.com',
        siteUrl: 'https://example.com',
        name: 'Boulangerie Dupont',
      }),
    ).rejects.toThrow(InternalServerErrorException);

    expect(usersService.delete).toHaveBeenCalledWith(
      'user-uuid-1',
      'user-uuid-1',
    );
    expect(apiKeysService.create).not.toHaveBeenCalled();
    // Workspace was never created → nothing to roll back on the workspace side.
    expect(workspacesService.delete).not.toHaveBeenCalled();
  });

  it('compensates by deleting the orphan workspace AND the user when API key creation fails', async () => {
    happyPathStubs();
    apiKeysService.create.mockRejectedValue(new Error('role denied'));

    await expect(
      service.provisionTenant({
        email: 'owner@example.com',
        siteUrl: 'https://example.com',
        name: 'Boulangerie Dupont',
      }),
    ).rejects.toThrow(InternalServerErrorException);

    // The workspace was created before the API key step failed → it MUST be
    // deleted so it doesn't linger as an orphan and derive a `_2` slug on the
    // next provision with the same name.
    expect(workspacesService.delete).toHaveBeenCalledWith('boulangerie_dupont');
    expect(usersService.delete).toHaveBeenCalledWith(
      'user-uuid-1',
      'user-uuid-1',
    );
  });

  it('marks phone numbers as skipped_no_bridge when BRIDGE_URL unset', async () => {
    happyPathStubs();

    const result = await service.provisionTenant({
      email: 'owner@example.com',
      siteUrl: 'https://example.com',
      name: 'Boulangerie Dupont',
      phoneNumbers: [
        { e164: '+33123456789', source: 'seo' },
        { e164: '+33987654321', source: 'ads' },
      ],
    });

    expect(result.phone_numbers).toHaveLength(2);
    expect(result.phone_numbers[0]).toMatchObject({
      e164: '+33123456789',
      source: 'seo',
      status: 'skipped_no_bridge',
    });
    expect(result.phone_numbers[1]).toMatchObject({
      e164: '+33987654321',
      source: 'ads',
      status: 'skipped_no_bridge',
    });
  });

  it('does not abort provisioning when magic-link email send fails', async () => {
    happyPathStubs();
    mailService.sendPasswordReset.mockRejectedValue(new Error('SMTP down'));

    const result = await service.provisionTenant({
      email: 'owner@example.com',
      siteUrl: 'https://example.com',
      name: 'Boulangerie Dupont',
    });

    // Still returns api_key — caller can re-trigger email later.
    expect(result.api_key).toBe('stam_live_deadbeef');
    expect(result.password_reset_url).toContain('/reset-password/');
  });

  describe('provisionApiKey (M2M, existing workspace)', () => {
    it('404 when the workspace does not exist', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // workspaceExists → false
      await expect(
        service.provisionApiKey({ workspace_id: 'ws_ghost' }),
      ).rejects.toMatchObject({ response: { error: 'workspace_not_found' } });
      expect(apiKeysService.createForPlatform).not.toHaveBeenCalled();
    });

    it('provisions a key for an existing workspace via createForPlatform', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'vrd_site_staging' }]); // exists
      apiKeysService.createForPlatform.mockResolvedValue({
        key: 'stam_live_abc',
        apiKey: { key_prefix: 'stam_live_abc12', workspace_id: 'vrd_site_staging' } as never,
      });
      const result = await service.provisionApiKey({
        workspace_id: 'vrd_site_staging',
        name: 'Tunnel key',
        role: 'admin',
      });
      expect(result).toEqual({
        workspace_id: 'vrd_site_staging',
        api_key: 'stam_live_abc',
        key_prefix: 'stam_live_abc12',
      });
      expect(apiKeysService.createForPlatform).toHaveBeenCalledWith({
        workspace_id: 'vrd_site_staging',
        name: 'Tunnel key',
        role: 'admin',
      });
    });
  });

  describe('revokeApiKey (M2M, existing workspace)', () => {
    it('404 when the workspace does not exist', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // workspaceExists → false
      await expect(
        service.revokeApiKey({ workspace_id: 'ws_ghost', key_id: 'k1' }),
      ).rejects.toMatchObject({ response: { error: 'workspace_not_found' } });
      expect(apiKeysService.revokeForPlatform).not.toHaveBeenCalled();
    });

    it('delegates to revokeForPlatform and returns the revoked metadata', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'vrd_site_prod' }]); // exists
      apiKeysService.revokeForPlatform.mockResolvedValue({
        id: 'apikey-9',
        key_prefix: 'stam_live_dead12',
        workspace_id: 'vrd_site_prod',
        status: 'revoked',
        revoked_at: '2026-06-17 10:00:00',
      } as never);

      const result = await service.revokeApiKey({
        workspace_id: 'vrd_site_prod',
        key_prefix: 'stam_live_dead12',
      });

      expect(apiKeysService.revokeForPlatform).toHaveBeenCalledWith({
        workspace_id: 'vrd_site_prod',
        key_id: undefined,
        key_prefix: 'stam_live_dead12',
      });
      expect(result).toEqual({
        workspace_id: 'vrd_site_prod',
        key_id: 'apikey-9',
        key_prefix: 'stam_live_dead12',
        status: 'revoked',
        revoked_at: '2026-06-17 10:00:00',
      });
    });
  });

  describe('listApiKeys (M2M, existing workspace)', () => {
    it('404 when the workspace does not exist', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // workspaceExists → false
      await expect(
        service.listApiKeys({ workspace_id: 'ws_ghost' }),
      ).rejects.toMatchObject({ response: { error: 'workspace_not_found' } });
      expect(apiKeysService.listForPlatform).not.toHaveBeenCalled();
    });

    it('returns the workspace keys (metadata only)', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'vrd_site_prod' }]); // exists
      apiKeysService.listForPlatform.mockResolvedValue([
        { id: 'apikey-1', key_prefix: 'stam_live_aaa', status: 'active' },
      ] as never);

      const result = await service.listApiKeys({
        workspace_id: 'vrd_site_prod',
        status: 'active',
      });

      expect(apiKeysService.listForPlatform).toHaveBeenCalledWith(
        'vrd_site_prod',
        'active',
      );
      expect(result).toEqual({
        workspace_id: 'vrd_site_prod',
        api_keys: [
          { id: 'apikey-1', key_prefix: 'stam_live_aaa', status: 'active' },
        ],
      });
    });
  });

  // ─── Lot A — workspaces.status ──────────────────────────────────────

  describe('getConsolidatedStatus (M2M)', () => {
    it('returns exists=false with null fields when workspace is unknown', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // workspaceExists → false

      const result = await service.getConsolidatedStatus('ws_ghost');

      expect(result).toEqual({
        workspace_id: 'ws_ghost',
        exists: false,
        name: null,
        status: null,
        tracking: null,
        gsc: null,
        voip: null,
        webhooks: null,
        snippet_html: null,
      });
      // No connector probe should run for a missing workspace.
      expect(analyticsService.query).not.toHaveBeenCalled();
      expect(gscService.status).not.toHaveBeenCalled();
      expect(voipService.listCredentials).not.toHaveBeenCalled();
      expect(webhooksService.list).not.toHaveBeenCalled();
    });

    it('composes the consolidated shape from every connector service', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'vrd_site_prod' }]); // exists
      (workspacesService.get as jest.Mock).mockResolvedValue({
        id: 'vrd_site_prod',
        name: 'Boulangerie Dupont',
        status: 'active',
        timezone: 'Europe/Paris',
      });
      // probeTracking fires 3 queries via Promise.all, in array order:
      //   1) sessions / 30d → 42, 2) unique_visitors / 30d → 30, 3) sessions / 30min (live) → 3
      analyticsService.query
        .mockResolvedValueOnce({ data: [{ sessions: 42 }], meta: {} } as never)
        .mockResolvedValueOnce({ data: [{ unique_visitors: 30 }], meta: {} } as never)
        .mockResolvedValueOnce({ data: [{ sessions: 3 }], meta: {} } as never);
      gscService.status.mockResolvedValue({
        connected: true,
        site_url: 'sc-domain:example.com',
        ownership_state: 'verified',
        last_sync_at: '2026-06-20 09:00:00',
      });
      voipService.listCredentials.mockResolvedValue([
        {
          kind: 'voip_ovh',
          label: 'OVH',
          status: 'ok',
          masked: {},
          lastSyncAt: '2026-06-20 08:00:00',
          lastTestedAt: null,
          lastError: null,
          createdAt: '2026-06-01 00:00:00',
          updatedAt: '2026-06-20 08:00:00',
        },
      ]);
      voipService.listPhoneNumbers.mockResolvedValue({
        phoneNumbers: [
          {
            id: 'phn_1',
            e164: '+33123456789',
            source: 'seo',
            label: 'Accueil',
            createdAt: '2026-06-01 00:00:00',
            updatedAt: '2026-06-01 00:00:00',
          },
        ],
        allowedSources: ['seo'] as never,
      });
      webhooksService.list.mockResolvedValue([
        {
          id: 'wh_1',
          name: 'Twenty',
          url: 'https://example.com/hook',
          active: true,
        } as never,
      ]);

      const result = await service.getConsolidatedStatus('vrd_site_prod');

      expect(result.exists).toBe(true);
      expect(result.name).toBe('Boulangerie Dupont');
      expect(result.status).toBe('active');
      expect(result.tracking).toEqual({
        active: true,
        sessions_30d: 42,
        visitors_30d: 30,
        live: true,
      });
      expect(result.gsc).toEqual({
        connected: true,
        site_url: 'sc-domain:example.com',
        ownership_state: 'verified',
        last_sync_at: '2026-06-20 09:00:00',
      });
      expect(result.voip).toMatchObject({
        configured: true,
        phone_number_count: 1,
        last_sync_at: '2026-06-20 08:00:00',
        credential_kinds: ['voip_ovh'],
      });
      expect(result.voip?.phone_numbers).toEqual([
        { e164: '+33123456789', source: 'seo', label: 'Accueil' },
      ]);
      expect(result.webhooks).toEqual({
        active_count: 1,
        webhooks: [
          {
            id: 'wh_1',
            name: 'Twenty',
            url: 'https://example.com/hook',
            active: true,
          },
        ],
      });
      expect(result.snippet_html).toContain('vrd_site_prod');
    });

    it('degrades a failing tracking probe to active=false instead of throwing', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'vrd_site_prod' }]); // exists
      (workspacesService.get as jest.Mock).mockResolvedValue({
        id: 'vrd_site_prod',
        name: 'X',
        status: 'active',
      });
      analyticsService.query.mockRejectedValue(new Error('CH down'));

      const result = await service.getConsolidatedStatus('vrd_site_prod');

      expect(result.exists).toBe(true);
      expect(result.tracking).toEqual({
        active: false,
        sessions_30d: 0,
        visitors_30d: 0,
        live: false,
      });
    });
  });

  // ─── Lot B — VoIP M2M ───────────────────────────────────────────────

  describe('VoIP M2M', () => {
    it('voipAddPhoneNumber delegates to VoipService.createPhoneNumber', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      voipService.createPhoneNumber.mockResolvedValue({
        id: 'phn_1',
        e164: '+33123456789',
        source: 'ads',
        label: null,
        createdAt: 'x',
        updatedAt: 'x',
      });

      const result = await service.voipAddPhoneNumber({
        workspace_id: 'ws1',
        e164: '+33123456789',
        source: 'ads',
      });

      expect(voipService.createPhoneNumber).toHaveBeenCalledWith(
        'ws1',
        '+33123456789',
        'ads',
        null,
      );
      expect(result).toEqual({
        ok: true,
        phoneNumber: expect.objectContaining({ id: 'phn_1' }),
      });
    });

    it('voipAddPhoneNumber 404s on a missing workspace (no delegation)', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // not exists
      await expect(
        service.voipAddPhoneNumber({
          workspace_id: 'ws_ghost',
          e164: '+33123456789',
          source: 'seo',
        }),
      ).rejects.toMatchObject({ response: { error: 'workspace_not_found' } });
      expect(voipService.createPhoneNumber).not.toHaveBeenCalled();
    });

    it('voipSaveCredential delegates (creds write-only) and never returns the secret', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      voipService.saveCredential.mockResolvedValue({
        kind: 'voip_ovh',
        label: 'OVH',
        status: 'untested',
        masked: { appKey: '****' },
        lastSyncAt: null,
        lastTestedAt: null,
        lastError: null,
        createdAt: 'x',
        updatedAt: 'x',
      });

      const result = await service.voipSaveCredential({
        workspace_id: 'ws1',
        kind: 'voip_ovh',
        creds: { appKey: 'secret', appSecret: 'secret' },
      });

      expect(voipService.saveCredential).toHaveBeenCalledWith(
        'ws1',
        'voip_ovh',
        { appKey: 'secret', appSecret: 'secret' },
      );
      // Response carries only the masked view — never the raw creds.
      expect(JSON.stringify(result)).not.toContain('"secret"');
      expect(result.credential.masked).toEqual({ appKey: '****' });
    });

    it('voipSync 404s on missing workspace and otherwise delegates to syncAll', async () => {
      clickhouse.querySystem.mockResolvedValueOnce([]); // not exists
      await expect(service.voipSync('ws_ghost')).rejects.toMatchObject({
        response: { error: 'workspace_not_found' },
      });
      expect(voipSyncService.syncAll).not.toHaveBeenCalled();

      clickhouse.querySystem.mockResolvedValueOnce([{ id: 'ws1' }]); // exists
      voipSyncService.syncAll.mockResolvedValue({
        syncedWorkspaces: 2,
        pushedEvents: 5,
      });
      const result = await service.voipSync('ws1');
      expect(result).toEqual({
        ok: true,
        syncedWorkspaces: 2,
        pushedEvents: 5,
      });
    });
  });

  // ─── Lot C — GSC M2M ────────────────────────────────────────────────

  describe('GSC M2M', () => {
    it('gscResync 404s on missing workspace and otherwise delegates with days', async () => {
      clickhouse.querySystem.mockResolvedValueOnce([]); // not exists
      await expect(service.gscResync('ws_ghost', 7)).rejects.toMatchObject({
        response: { error: 'workspace_not_found' },
      });
      expect(gscService.resync).not.toHaveBeenCalled();

      clickhouse.querySystem.mockResolvedValueOnce([{ id: 'ws1' }]); // exists
      await service.gscResync('ws1', 7);
      expect(gscService.resync).toHaveBeenCalledWith('ws1', 7);
    });

    it('gscResync defaults days to 30', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      await service.gscResync('ws1');
      expect(gscService.resync).toHaveBeenCalledWith('ws1', 30);
    });
  });

  // ─── Lot D — Webhooks M2M ───────────────────────────────────────────

  describe('Webhooks M2M', () => {
    it('webhooksCreate delegates to WebhooksService.create (SSRF enforced there)', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      webhooksService.create.mockResolvedValue({ id: 'wh_1' } as never);
      const dto = {
        workspace_id: 'ws1',
        name: 'Twenty',
        url: 'https://example.com/hook',
        events: ['goal'],
      };
      const result = await service.webhooksCreate(dto as never);
      expect(webhooksService.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ id: 'wh_1' });
    });

    it('webhooksTest sends one delivery via the worker and persists the outcome', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      webhooksService.findById.mockResolvedValue({
        id: 'wh_1',
        workspace_id: 'ws1',
        url: 'https://example.com/hook',
      } as never);
      webhooksService.enqueueDelivery.mockResolvedValue({
        id: 'del_1',
      } as never);
      webhookDeliveryWorker.sendOne.mockResolvedValue({
        success: true,
        http_status: 200,
        latency_ms: 12,
        response_body: 'ok',
        error_message: '',
      });

      const result = await service.webhooksTest({
        workspace_id: 'ws1',
        id: 'wh_1',
      } as never);

      expect(webhookDeliveryWorker.sendOne).toHaveBeenCalled();
      expect(webhooksService.updateDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', http_status: 200 }),
      );
      expect(result).toEqual({
        delivery_id: 'del_1',
        success: true,
        http_status: 200,
        latency_ms: 12,
        response_body: 'ok',
        error_message: '',
      });
    });

    it('webhooksTest 404s when the webhook does not exist', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      webhooksService.findById.mockResolvedValue(null);
      await expect(
        service.webhooksTest({ workspace_id: 'ws1', id: 'nope' } as never),
      ).rejects.toMatchObject({ response: { code: 'WEBHOOK_NOT_FOUND' } });
      expect(webhookDeliveryWorker.sendOne).not.toHaveBeenCalled();
    });
  });

  // ─── Lot E — workspaces.updateSettings M2M ──────────────────────────

  describe('updateWorkspaceSettings (M2M)', () => {
    it('maps workspace_id → id and delegates to WorkspacesService.update', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      (workspacesService.update as jest.Mock).mockResolvedValue({
        id: 'ws1',
        timezone: 'Europe/Paris',
      });

      const result = await service.updateWorkspaceSettings({
        workspace_id: 'ws1',
        timezone: 'Europe/Paris',
        currency: 'EUR',
      });

      expect(workspacesService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ws1',
          timezone: 'Europe/Paris',
          currency: 'EUR',
        }),
      );
      expect(result).toMatchObject({ id: 'ws1' });
    });

    it('404s on a missing workspace (no delegation)', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // not exists
      await expect(
        service.updateWorkspaceSettings({
          workspace_id: 'ws_ghost',
          timezone: 'Europe/Paris',
        }),
      ).rejects.toMatchObject({ response: { error: 'workspace_not_found' } });
      expect(workspacesService.update).not.toHaveBeenCalled();
    });
  });

  // ─── Lot H — Customization M2M (branding / features / layout / CRM) ──────

  describe('customization M2M (N1–N4)', () => {
    beforeEach(() => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      (workspacesService.update as jest.Mock).mockResolvedValue({} as never);
    });

    it('setBranding writes the accent color and returns a snapshot', async () => {
      (workspacesService.get as jest.Mock).mockResolvedValue({
        id: 'ws1',
        name: 'Yoga Sculpt',
        logo_url: 'https://x.fr/logo.png',
        settings: { branding: { color: '#ff8800' } },
      });
      const res = await service.setBranding({
        workspace_id: 'ws1',
        branding: { color: '#ff8800' },
      });
      expect(workspacesService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ws1',
          settings: { branding: { color: '#ff8800' } },
        }),
      );
      expect(res).toMatchObject({ branding: { color: '#ff8800' } });
    });

    it('setFeatures DEEP-merges over the existing flags', async () => {
      (workspacesService.get as jest.Mock).mockResolvedValue({
        id: 'ws1',
        name: 'Yoga',
        settings: { features: { voip: true, gsc: true } },
      });
      await service.setFeatures({
        workspace_id: 'ws1',
        features: { gsc: false },
      });
      expect(workspacesService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { features: { voip: true, gsc: false } },
        }),
      );
    });

    it('setFeatures ignores undefined flags so a partial update never wipes siblings', async () => {
      // Reproduces the transformed-DTO shape (class-transformer materialises
      // every declared flag; unset ones = undefined own keys). The merge must
      // start from the persisted flags and apply ONLY the provided one — the
      // staging data-loss bug (2026-06-24) was these undefined values clobbering
      // gsc/connectors down to `{ voip: true }`.
      (workspacesService.get as jest.Mock).mockResolvedValue({
        id: 'ws1',
        name: 'Yoga',
        settings: { features: { voip: false, gsc: false, connectors: false } },
      });
      await service.setFeatures({
        workspace_id: 'ws1',
        // gsc + connectors arrive as undefined (not provided by the caller).
        features: { voip: true, gsc: undefined, connectors: undefined } as never,
      });
      expect(workspacesService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { features: { voip: true, gsc: false, connectors: false } },
        }),
      );
    });

    it('setCrmMapping replaces the mapping and getCrmMapping reads it back', async () => {
      const mapping = {
        identity_resolver: 'field' as const,
        identity_field: 'supabaseId',
        goals: [{ match: 'goal:purchase', timeline_name: 'achat' }],
      };
      (workspacesService.get as jest.Mock).mockResolvedValue({
        id: 'ws1',
        name: 'Yoga',
        settings: { crm_mapping: mapping },
      });
      const res = await service.setCrmMapping({
        workspace_id: 'ws1',
        crm_mapping: mapping,
      });
      expect(workspacesService.update).toHaveBeenCalledWith(
        expect.objectContaining({ settings: { crm_mapping: mapping } }),
      );
      expect(res).toEqual({ workspace_id: 'ws1', crm_mapping: mapping });
    });

    it('getCustomization 404s on a missing workspace', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // not exists
      await expect(
        service.getCustomization({ workspace_id: 'ghost' }),
      ).rejects.toMatchObject({ response: { error: 'workspace_not_found' } });
    });
  });

  // ─── Lot F — ads.conversions ────────────────────────────────────────

  describe('getAdsConversions (M2M, read-only)', () => {
    it('404s on a missing workspace (no query)', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // not exists
      await expect(
        service.getAdsConversions({ workspace_id: 'ws_ghost' }),
      ).rejects.toMatchObject({ response: { error: 'workspace_not_found' } });
      expect(clickhouse.queryWorkspace).not.toHaveBeenCalled();
    });

    it('maps click-id and phone rows into the typed conversion shape', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      clickhouse.queryWorkspace.mockResolvedValue([
        {
          click_id_source: 'gclid',
          click_id: 'EAIaIQ-gclid-123',
          conversion_type: 'form_submission',
          timestamp: '2026-06-20 10:00:00.000',
          value: 42,
          user_id: 'user-1',
          path: '/contact',
          phone_number: '',
        },
        {
          click_id_source: 'phone_source_ads',
          click_id: '',
          conversion_type: 'phone_call',
          timestamp: '2026-06-20 11:00:00.000',
          value: 120,
          user_id: null,
          path: '/voip',
          phone_number: '+33177123456',
        },
      ] as never);

      const result = await service.getAdsConversions({ workspace_id: 'ws1' });

      expect(clickhouse.queryWorkspace).toHaveBeenCalledTimes(1);
      // Query is scoped to the workspace + parameterized (no interpolation).
      const [wsArg, sqlArg, paramsArg] = (
        clickhouse.queryWorkspace as jest.Mock
      ).mock.calls[0];
      expect(wsArg).toBe('ws1');
      expect(sqlArg).toContain('FROM events');
      expect(paramsArg.clickTypes).toEqual(['gclid', 'gbraid', 'wbraid']);

      expect(result.workspace_id).toBe('ws1');
      expect(result.count).toBe(2);
      expect(result.truncated).toBe(false);
      // Web click-id conversion keeps its raw click id; phone has none.
      expect(result.conversions[0]).toEqual({
        click_id_source: 'gclid',
        click_id: 'EAIaIQ-gclid-123',
        conversion_type: 'form_submission',
        timestamp: '2026-06-20 10:00:00.000',
        value: 42,
        user_id: 'user-1',
        path: '/contact',
        phone_number: null,
      });
      expect(result.conversions[1]).toMatchObject({
        click_id_source: 'phone_source_ads',
        click_id: null,
        conversion_type: 'phone_call',
        user_id: null,
        phone_number: '+33177123456',
      });
    });

    it('defaults to a 28-day window when no range is supplied', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      clickhouse.queryWorkspace.mockResolvedValue([] as never);

      const result = await service.getAdsConversions({ workspace_id: 'ws1' });

      const fromMs = new Date(result.from).getTime();
      const toMs = new Date(result.to).getTime();
      const days = (toMs - fromMs) / 86_400_000;
      expect(Math.round(days)).toBe(28);
      expect(result.limit).toBe(1000);
      expect(result.count).toBe(0);
    });

    it('caps the limit at 10000 and flags truncation when the cap is hit', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws1' }]); // exists
      // Request a 2-row cap; return 3 (cap+1) → truncated, only 2 kept.
      clickhouse.queryWorkspace.mockResolvedValue(
        Array.from({ length: 3 }, (_, i) => ({
          click_id_source: 'gclid',
          click_id: `id-${i}`,
          conversion_type: 'goal',
          timestamp: '2026-06-20 10:00:00.000',
          value: 0,
          user_id: null,
          path: '/x',
          phone_number: '',
        })) as never,
      );

      const result = await service.getAdsConversions({
        workspace_id: 'ws1',
        limit: 2,
      });

      expect(result.limit).toBe(2);
      expect(result.count).toBe(2);
      expect(result.truncated).toBe(true);
      // queryWorkspace is asked for limit+1 to detect truncation.
      const paramsArg = (clickhouse.queryWorkspace as jest.Mock).mock
        .calls[0][2];
      expect(paramsArg.lim).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // tracking.verify (dry-run install check, zero-pollution)
  // ───────────────────────────────────────────────────────────────────────
  describe('verifyTracking', () => {
    const WS = 'ws_verify';

    /** Make workspaceExists() true (querySystem returns one row). */
    function workspaceExists(): void {
      clickhouse.querySystem.mockResolvedValue([{ id: WS }]);
      // The HTTP probe reads the workspace (deriveProbeOrigin / classifyHttpDrop).
      // Default: an active workspace with an open domain policy so the probe's
      // Origin is always accepted and a non-visible event is classified as a
      // CH/buffer issue, not a gate drop.
      workspacesService.get.mockResolvedValue({
        id: WS,
        status: 'active',
        website: 'https://client.example',
        settings: { allowed_domains: [] },
      } as never);
    }

    /**
     * URL-aware global.fetch stub. verifyTracking now issues TWO kinds of fetch:
     *   1. POST http://127.0.0.1:<PORT>/api/track  — the REAL ingestion probe.
     *   2. GET  <site_url>                          — the optional snippet probe.
     * We answer the /api/track POST with a 200 (its visibility is driven by the
     * queryWorkspace count-back, wired via ingestionVisible) and delegate the
     * snippet GET to `snippetResponder`. `trackResponder` lets a test override
     * the /api/track answer (e.g. to simulate a kill-switch / domain drop).
     */
    function stubFetch(opts: {
      snippet?: () => unknown | Promise<unknown>;
      track?: () => unknown | Promise<unknown>;
    }): jest.SpyInstance {
      return jest
        .spyOn(global, 'fetch')
        .mockImplementation(((input: unknown, init?: { method?: string }) => {
          const url = String(input);
          const isTrack =
            url.includes('/api/track') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST';
          if (isTrack) {
            return Promise.resolve(
              (opts.track
                ? opts.track()
                : { ok: true, status: 200, text: async () => '{"success":true}' }) as never,
            );
          }
          // snippet GET
          if (!opts.snippet) {
            return Promise.reject(new Error('no snippet responder stubbed'));
          }
          return Promise.resolve(opts.snippet() as never);
        }) as never);
    }

    /**
     * Drive the ingestion round trip:
     *   - the events count-back query (queryWorkspace) returns `visible`
     *   - real_tracking probe (analyticsService.query) returns sessions count
     * The service issues the events count-back via queryWorkspace and the
     * sessions count via analyticsService.query (countSessions), so we wire
     * them separately. Also stubs /api/track to 200 by default (snippet-less
     * tests rely on this so the HTTP probe succeeds).
     */
    function ingestionVisible(visible: boolean): void {
      // queryWorkspace serves two DIFFERENT polls:
      //   • event visibility (FROM events WHERE … dedup_token) → must reflect
      //     `visible`.
      //   • session-purged check (FROM sessions WHERE id …) → must report the
      //     synthetic row is GONE (count 0) so waitForSessionPurged returns
      //     immediately instead of polling the full timeout under real timers.
      clickhouse.queryWorkspace.mockImplementation(((
        _ws: string,
        sql: string,
      ) => {
        if (/FROM sessions\b/i.test(sql)) {
          return Promise.resolve([{ c: 0 }] as never);
        }
        return Promise.resolve((visible ? [{ c: 1 }] : [{ c: 0 }]) as never);
      }) as never);
      // Default: the /api/track POST answers 200; snippet GET rejects (no
      // site_url in most ingestion-only tests, so it is never called).
      stubFetch({});
    }

    afterEach(() => {
      // Restore any fetch stub between tests.
      jest.restoreAllMocks();
    });

    it('returns workspace_not_found when the workspace does not exist', async () => {
      clickhouse.querySystem.mockResolvedValue([]); // not exists

      const res = await service.verifyTracking({ workspace_id: 'nope' });

      expect(res.workspace_exists).toBe(false);
      expect(res.verdict).toBe('workspace_not_found');
      expect(res.ingestion.ok).toBe(false);
      // No synthetic event should ever be inserted for a missing workspace.
      expect(clickhouse.insertWorkspace).not.toHaveBeenCalled();
    });

    it('verdict=ok and PURGES the synthetic event (no site_url)', async () => {
      workspaceExists();
      ingestionVisible(true);
      // real_tracking probe → 0 sessions (irrelevant to verdict).
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);

      const res = await service.verifyTracking({ workspace_id: WS });

      expect(res.workspace_exists).toBe(true);
      expect(res.ingestion.ok).toBe(true);
      expect(res.ingestion.round_trip_ms).toEqual(expect.any(Number));
      // ok now comes from the REAL HTTP /api/track probe.
      expect(res.ingestion.detail).toContain('real HTTP POST /api/track ingested');
      expect(res.ingestion.drop_reason).toBeNull();
      // The low-level table+MV chain is still checked alongside.
      expect(res.ingestion.low_level_chain_ok).toBe(true);
      expect(res.snippet).toBeNull();
      expect(res.verdict).toBe('ok');

      // The HONEST probe POSTs to the real /api/track door (loopback).
      const fetchCalls = (global.fetch as jest.Mock).mock.calls;
      const trackCall = fetchCalls.find(
        ([url, init]) =>
          String(url).includes('/api/track') &&
          (init as { method?: string } | undefined)?.method === 'POST',
      );
      expect(trackCall).toBeDefined();
      const trackBody = JSON.parse(
        (trackCall![1] as { body: string }).body,
      ) as Record<string, unknown>;
      expect(trackBody.workspace_id).toBe(WS);
      expect(trackBody.session_id).toBe(`__veridian_verify_http__${WS}`);

      // Low-level chain still exercised (insert into events table, proves CH).
      expect(clickhouse.insertWorkspace).toHaveBeenCalledWith(
        WS,
        'events',
        expect.arrayContaining([
          expect.objectContaining({
            session_id: `__veridian_verify__${WS}`,
            dedup_token: `__veridian_verify__${WS}_pv`,
            name: 'screen_view',
            // Far-past sentinel keeps it out of every date-bounded report.
            created_at: '2000-01-01 00:00:00.000',
          }),
        ]),
      );

      // Purge runs against events + the 3 MV targets (sessions/pages/goals).
      const purgedTables = (
        clickhouse.commandWorkspaceWithParams as jest.Mock
      ).mock.calls.map((c) => c[1] as string);
      expect(purgedTables.some((q) => /ALTER TABLE events DELETE/.test(q))).toBe(
        true,
      );
      expect(
        purgedTables.some((q) => /ALTER TABLE sessions DELETE/.test(q)),
      ).toBe(true);
      expect(purgedTables.some((q) => /ALTER TABLE pages DELETE/.test(q))).toBe(
        true,
      );
      expect(purgedTables.some((q) => /ALTER TABLE goals DELETE/.test(q))).toBe(
        true,
      );
    });

    it('verdict=ingestion_failed when the synthetic event never becomes requeryable', async () => {
      workspaceExists();
      ingestionVisible(false); // count-back always 0 → not requeryable
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);

      // The probe polls for up to 8s (VERIFY_INGEST_TIMEOUT_MS) when the event
      // never becomes visible. Fake timers advance that wait virtually so the
      // test stays fast (no real 8s wait → no jest 5s timeout).
      jest.useFakeTimers();
      try {
        const promise = service.verifyTracking({ workspace_id: WS });
        // Advance past the full ingest poll window, flushing microtasks so the
        // awaited query mock + sleep() resolve between ticks.
        await jest.advanceTimersByTimeAsync(9000);
        const res = await promise;

        expect(res.ingestion.ok).toBe(false);
        expect(res.ingestion.round_trip_ms).toBeNull();
        // Active workspace + open domains, yet event never surfaced → the
        // storage chain, not a gate, is the suspect.
        expect(res.ingestion.drop_reason).toBe('not_requeryable');
        expect(res.verdict).toBe('ingestion_failed');
        // Even on failure we still purge (no orphan synthetic row).
        expect(clickhouse.commandWorkspaceWithParams).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    // ─── The honest-verify regression guards: a REAL door drop must be SEEN ──
    // These are the tests that would have caught the P0 (kill-switch dropping
    // every `initializing` workspace) instead of reporting a false `ok`.

    it('verdict=dropped_workspace_inactive when the kill-switch silently drops (HTTP 200 but no row, status inactive)', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: WS }]); // exists
      // /api/track answers 200 (the silent kill-switch 200), but the event
      // never surfaces in ClickHouse — exactly the P0 failure mode.
      ingestionVisible(false);
      // The workspace the probe reads to classify the drop is INACTIVE.
      workspacesService.get.mockResolvedValue({
        id: WS,
        status: 'inactive',
        website: 'https://client.example',
        settings: { allowed_domains: [] },
      } as never);
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);

      jest.useFakeTimers();
      try {
        const promise = service.verifyTracking({ workspace_id: WS });
        await jest.advanceTimersByTimeAsync(9000);
        const res = await promise;

        expect(res.ingestion.ok).toBe(false);
        expect(res.ingestion.drop_reason).toBe('workspace_inactive');
        expect(res.verdict).toBe('dropped_workspace_inactive');
        expect(res.ingestion.detail).toContain('kill-switch');
      } finally {
        jest.useRealTimers();
      }
    });

    it('verdict=dropped_domain_not_allowed when the domain-check silently drops (HTTP 200 but no row, Origin not allowed)', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: WS }]);
      ingestionVisible(false);
      // Active workspace, but its allowed_domains do NOT cover the probe Origin
      // we derive from them — simulate by reading back a different host on the
      // classify call than the one we POST. Easiest: allowed_domains points at a
      // host, then the classify re-read returns a DISJOINT list. We model the
      // real "Origin not allowed" by making deriveProbeOrigin and classify see
      // an allowed list whose host can never match the derived Origin.
      // deriveProbeOrigin builds `https://<first allowed host>`, which WOULD
      // match — so to exercise domain_not_allowed we point the classify read at
      // a list that excludes that host. We do this by returning, on the classify
      // call, a list with a host the derived Origin is not under.
      let getCall = 0;
      workspacesService.get.mockImplementation(() => {
        getCall += 1;
        // 1st get = deriveProbeOrigin (build Origin from a host we then drop);
        // later gets = classifyHttpDrop (allowed list excludes that host).
        const allowed =
          getCall === 1 ? ['*.allowed-host.example'] : ['*.other-host.example'];
        return Promise.resolve({
          id: WS,
          status: 'active',
          website: 'https://client.example',
          settings: { allowed_domains: allowed },
        } as never);
      });
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);

      jest.useFakeTimers();
      try {
        const promise = service.verifyTracking({ workspace_id: WS });
        await jest.advanceTimersByTimeAsync(9000);
        const res = await promise;

        expect(res.ingestion.ok).toBe(false);
        expect(res.ingestion.drop_reason).toBe('domain_not_allowed');
        expect(res.verdict).toBe('dropped_domain_not_allowed');
      } finally {
        jest.useRealTimers();
      }
    });

    it('verdict=ingestion_failed when /api/track validation rejects the payload (HTTP 400)', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: WS }]);
      ingestionVisible(true); // CH would be fine, but the door 400s first.
      workspacesService.get.mockResolvedValue({
        id: WS,
        status: 'active',
        website: 'https://client.example',
        settings: { allowed_domains: [] },
      } as never);
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);
      // /api/track refuses the synthetic payload at the validation pipe.
      stubFetch({
        track: () => ({ ok: false, status: 400, text: async () => 'Bad Request' }),
      });

      const res = await service.verifyTracking({ workspace_id: WS });

      expect(res.ingestion.ok).toBe(false);
      expect(res.ingestion.drop_reason).toBe('validation_rejected');
      expect(res.verdict).toBe('ingestion_failed');
    });

    it('verdict=snippet_missing when site_url HTML has no tracker script', async () => {
      workspaceExists();
      ingestionVisible(true);
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);
      // Blanket 200 HTML: also answers the /api/track POST (status 200 →
      // visibility driven by ingestionVisible(true) → ingestion.ok stays true).
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html><head><title>no tracker here</title></head></html>',
      } as never);

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://client.example',
      });

      expect(res.ingestion.ok).toBe(true);
      expect(res.snippet).not.toBeNull();
      expect(res.snippet!.checked).toBe(true);
      expect(res.snippet!.present).toBe(false);
      expect(res.verdict).toBe('snippet_missing');
    });

    it('verdict=ok (NOT snippet_missing) when static HTML has no snippet but real traffic is live (SPA install)', async () => {
      // Yoga Sculpt case: tracker injected client-side via a React effect, so
      // it's absent from the server-fetched HTML, yet ingestion is live.
      workspaceExists();
      ingestionVisible(true);
      // real_tracking: live traffic right now (30d>0, 30min>0).
      // probeTracking order: sessions/30d, unique_visitors/30d, sessions/30min.
      analyticsService.query
        .mockResolvedValueOnce({ data: [{ sessions: 120 }], meta: {} } as never) // 30d sessions
        .mockResolvedValueOnce({ data: [{ unique_visitors: 90 }], meta: {} } as never) // 30d visitors
        .mockResolvedValueOnce({ data: [{ sessions: 3 }], meta: {} } as never); // 30min live
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          '<html><head><title>SPA, no static tracker tag</title></head></html>',
      } as never);

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://spa-client.example',
      });

      expect(res.ingestion.ok).toBe(true);
      expect(res.snippet).not.toBeNull();
      // Static probe still reports present:false (informative, not a verdict).
      expect(res.snippet!.present).toBe(false);
      // Detail annotated to explain the false negative.
      expect(res.snippet!.detail).toContain('real live traffic is flowing');
      expect(res.real_tracking.live).toBe(true);
      // Live traffic proves the install — must NOT be snippet_missing.
      expect(res.verdict).toBe('ok');
    });

    it('verdict=snippet_missing when no static snippet AND no real live traffic', async () => {
      workspaceExists();
      ingestionVisible(true);
      // No real traffic at all.
      analyticsService.query
        .mockResolvedValueOnce({ data: [{ sessions: 0 }], meta: {} } as never) // 30d sessions
        .mockResolvedValueOnce({ data: [{ unique_visitors: 0 }], meta: {} } as never) // 30d visitors
        .mockResolvedValueOnce({ data: [{ sessions: 0 }], meta: {} } as never); // 30min live
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html><head><title>nothing here</title></head></html>',
      } as never);

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://dead-client.example',
      });

      expect(res.snippet!.present).toBe(false);
      expect(res.real_tracking.live).toBe(false);
      // No tag, no traffic → genuinely not installed.
      expect(res.verdict).toBe('snippet_missing');
    });

    it('verdict=snippet_misconfigured even when traffic is live (actionable install bug is always reported)', async () => {
      workspaceExists();
      ingestionVisible(true);
      // probeTracking order: sessions/30d, unique_visitors/30d, sessions/30min.
      analyticsService.query
        .mockResolvedValueOnce({ data: [{ sessions: 50 }], meta: {} } as never) // 30d sessions
        .mockResolvedValueOnce({ data: [{ unique_visitors: 40 }], meta: {} } as never) // 30d visitors
        .mockResolvedValueOnce({ data: [{ sessions: 2 }], meta: {} } as never); // 30min live
      // Tag present but wrong workspace id — a real mistake worth surfacing
      // regardless of (possibly unrelated) live traffic.
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          `<html><head><script async src="https://t.example/sdk/v1/tracker.js" data-workspace-id="wrong_ws"></script></head></html>`,
      } as never);

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://misconfigured.example',
      });

      expect(res.snippet!.present).toBe(true);
      expect(res.snippet!.workspace_id_match).toBe(false);
      expect(res.verdict).toBe('snippet_misconfigured');
    });

    it('verdict=snippet_misconfigured when src points at the bare /tracker.js SPA trap', async () => {
      workspaceExists();
      ingestionVisible(true);
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);
      // Wrong src (root /tracker.js = SPA HTML, tracks nothing) but right ws id.
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          `<html><head><script async src="https://t.example/tracker.js" data-workspace-id="${WS}"></script></head></html>`,
      } as never);

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://client.example',
      });

      expect(res.snippet!.present).toBe(true);
      expect(res.snippet!.src_correct).toBe(false);
      expect(res.snippet!.workspace_id_match).toBe(true);
      expect(res.verdict).toBe('snippet_misconfigured');
    });

    it('verdict=snippet_misconfigured when data-workspace-id does not match', async () => {
      workspaceExists();
      ingestionVisible(true);
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          `<html><head><script async src="https://t.example/sdk/v1/tracker.js" data-workspace-id="some_other_ws"></script></head></html>`,
      } as never);

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://client.example',
      });

      expect(res.snippet!.present).toBe(true);
      expect(res.snippet!.src_correct).toBe(true);
      expect(res.snippet!.workspace_id_match).toBe(false);
      expect(res.verdict).toBe('snippet_misconfigured');
    });

    it('verdict=ok with a correctly-installed snippet, and surfaces real_tracking', async () => {
      workspaceExists();
      ingestionVisible(true);
      // Real tracking already flowing. probeTracking order:
      //   sessions/30d → 42, unique_visitors/30d → 28, sessions/30min (live) → 1
      analyticsService.query
        .mockResolvedValueOnce({ data: [{ sessions: 42 }], meta: {} } as never) // 30d sessions
        .mockResolvedValueOnce({ data: [{ unique_visitors: 28 }], meta: {} } as never) // 30d visitors
        .mockResolvedValueOnce({ data: [{ sessions: 1 }], meta: {} } as never); // 30min live
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          `<html><head><script async src="https://t.example/sdk/v1/tracker.js" data-workspace-id="${WS}"></script></head></html>`,
      } as never);

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://client.example',
      });

      expect(res.snippet!.present).toBe(true);
      expect(res.snippet!.src_correct).toBe(true);
      expect(res.snippet!.workspace_id_match).toBe(true);
      expect(res.real_tracking.sessions_30d).toBe(42);
      expect(res.real_tracking.live).toBe(true);
      expect(res.verdict).toBe('ok');
    });

    it('does not down-rank to snippet_missing when the site is unreachable (fail-soft)', async () => {
      workspaceExists();
      ingestionVisible(true);
      analyticsService.query.mockResolvedValue({
        data: [{ sessions: 0 }],
        meta: {},
      } as never);
      // ONLY the snippet GET is unreachable; the /api/track ingestion probe
      // must still succeed (it is a loopback to our own API, not the down site).
      stubFetch({
        track: () => ({ ok: true, status: 200, text: async () => '{"success":true}' }),
        snippet: () => {
          throw new Error('ETIMEDOUT');
        },
      });

      const res = await service.verifyTracking({
        workspace_id: WS,
        site_url: 'https://down.example',
      });

      expect(res.ingestion.ok).toBe(true);
      expect(res.snippet!.present).toBe(false);
      expect(res.snippet!.detail).toContain('could not fetch site');
      // Unreachable site is an availability issue, not a confirmed missing tag.
      expect(res.verdict).toBe('ok');
    });

    // ─── SSRF guard on the site probe (caller-supplied site_url) ──────────
    describe('SSRF guard on site_url probe', () => {
      // The probe must block a public hostname that resolves to a private /
      // loopback / cloud-metadata address, WITHOUT ever issuing the fetch.
      // It must stay fail-soft (present:false + detail), never throw the
      // endpoint, and never down-rank an otherwise-ok verdict.
      const blocked = [
        ['loopback', '127.0.0.1'],
        ['cloud metadata', '169.254.169.254'],
        ['RFC1918 10/8', '10.0.0.5'],
        ['RFC1918 192.168', '192.168.1.10'],
      ] as const;

      for (const [label, ip] of blocked) {
        it(`blocks a site_url resolving to a ${label} address (${ip}) without fetching`, async () => {
          workspaceExists();
          ingestionVisible(true);
          analyticsService.query.mockResolvedValue({
            data: [{ sessions: 0 }],
            meta: {},
          } as never);
          // Hostname looks public but DNS points at a private/metadata IP.
          ssrfResolve = async () => [{ address: ip, family: 4 }];
          // ingestionVisible(true) already stubbed fetch (/api/track → 200).
          const fetchSpy = global.fetch as jest.Mock;

          const res = await service.verifyTracking({
            workspace_id: WS,
            site_url: 'https://evil-rebind.example',
          });

          // The guard short-circuited BEFORE any fetch to the site_url — the
          // only fetch allowed is the loopback /api/track ingestion probe.
          const siteFetched = fetchSpy.mock.calls.some(([url]) =>
            String(url).includes('evil-rebind.example'),
          );
          expect(siteFetched).toBe(false);
          // Fail-soft: probe reports a fetch failure, endpoint does not throw.
          expect(res.snippet!.checked).toBe(true);
          expect(res.snippet!.present).toBe(false);
          expect(res.snippet!.detail).toContain('could not fetch site');
          // Ingestion was fine → blocking the (malicious) probe must not fail it.
          expect(res.verdict).toBe('ok');
        });
      }

      it('lets a real public client domain through to the fetch', async () => {
        workspaceExists();
        ingestionVisible(true);
        analyticsService.query.mockResolvedValue({
          data: [{ sessions: 0 }],
          meta: {},
        } as never);
        // Public IP (default resolver), tracker correctly installed.
        const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
          ok: true,
          status: 200,
          text: async () =>
            `<html><head><script async src="https://t.example/sdk/v1/tracker.js" data-workspace-id="${WS}"></script></head></html>`,
        } as never);

        const res = await service.verifyTracking({
          workspace_id: WS,
          site_url: 'https://real-client.example',
        });

        // The guard allowed the public host → fetch ran → snippet parsed.
        expect(fetchSpy).toHaveBeenCalled();
        expect(res.snippet!.present).toBe(true);
        expect(res.snippet!.src_correct).toBe(true);
        expect(res.snippet!.workspace_id_match).toBe(true);
      });

      it('re-validates each redirect hop (3xx toward a private IP is blocked)', async () => {
        workspaceExists();
        ingestionVisible(true);
        analyticsService.query.mockResolvedValue({
          data: [{ sessions: 0 }],
          meta: {},
        } as never);
        // First host public, redirect target host private — second-hop resolve
        // must reject before the second fetch fires.
        ssrfResolve = async (hostname: string) =>
          hostname === 'internal.evil.example'
            ? [{ address: '169.254.169.254', family: 4 }]
            : [{ address: PUBLIC_IP, family: 4 }];
        // /api/track → 200 (loopback ingestion). The site_url GET → 302 toward a
        // private target whose second hop the SSRF guard must block.
        const fetchSpy = stubFetch({
          track: () => ({
            ok: true,
            status: 200,
            text: async () => '{"success":true}',
          }),
          snippet: () => ({
            ok: false,
            status: 302,
            headers: {
              get: (h: string) =>
                h.toLowerCase() === 'location'
                  ? 'https://internal.evil.example/'
                  : null,
            },
            text: async () => '',
          }),
        });

        const res = await service.verifyTracking({
          workspace_id: WS,
          site_url: 'https://public-front.example',
        });

        // The site_url is fetched exactly once (the first hop); the second hop
        // is blocked by re-validation BEFORE any fetch to the private target.
        const siteFetchCount = fetchSpy.mock.calls.filter(([url]) =>
          /public-front\.example|internal\.evil\.example/.test(String(url)),
        ).length;
        expect(siteFetchCount).toBe(1);
        expect(res.snippet!.present).toBe(false);
        expect(res.snippet!.detail).toContain('could not fetch site');
        expect(res.verdict).toBe('ok');
      });
    });
  });

  describe('analytics delegation (funnel / conversionsByChannel)', () => {
    it('delegates analyticsFunnel to AnalyticsService.funnel', async () => {
      const dto = {
        workspace_id: 'ws_funnel_probe',
        steps: [{ goal_name: 'a' }, { goal_name: 'b' }],
        dateRange: { preset: 'previous_7_days' as const },
      };
      const out = { entered: 5, steps: [] };
      analyticsService.funnel.mockResolvedValue(out as never);

      const res = await service.analyticsFunnel(dto as never);

      expect(analyticsService.funnel).toHaveBeenCalledWith(dto);
      expect(res).toBe(out);
    });

    it('delegates analyticsConversionsByChannel to AnalyticsService.conversionsByChannel', async () => {
      const dto = {
        workspace_id: 'ws_conv_probe',
        dateRange: { preset: 'previous_30_days' as const },
      };
      const out = { rows: [{ channel_group: 'ads' }] };
      analyticsService.conversionsByChannel.mockResolvedValue(out as never);

      const res = await service.analyticsConversionsByChannel(dto as never);

      expect(analyticsService.conversionsByChannel).toHaveBeenCalledWith(dto);
      expect(res).toBe(out);
    });
  });
});
