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

describe('AdminPlatformService.provisionTenant', () => {
  let service: AdminPlatformService;
  let clickhouse: jest.Mocked<ClickHouseService>;
  let usersService: jest.Mocked<UsersService>;
  let workspacesService: jest.Mocked<WorkspacesService>;
  let apiKeysService: jest.Mocked<ApiKeysService>;
  let mailService: jest.Mocked<MailService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminPlatformService,
        {
          provide: ClickHouseService,
          useValue: {
            querySystem: jest.fn().mockResolvedValue([]),
            insertSystem: jest.fn().mockResolvedValue(undefined),
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
          },
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

    jest.clearAllMocks();
    // Re-stub after clearAllMocks
    clickhouse.querySystem.mockResolvedValue([]);
    clickhouse.insertSystem.mockResolvedValue(undefined);
    usersService.delete.mockResolvedValue(undefined);
    workspacesService.create.mockResolvedValue({} as never);
    mailService.sendPasswordReset.mockResolvedValue(undefined);
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
  });

  it('compensates by soft-deleting user when API key creation fails', async () => {
    happyPathStubs();
    apiKeysService.create.mockRejectedValue(new Error('role denied'));

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
});
