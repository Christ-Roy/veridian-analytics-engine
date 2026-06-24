import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { ClickHouseService } from '../database/clickhouse.service';
import {
  Workspace,
  DEFAULT_WORKSPACE_SETTINGS,
} from './entities/workspace.entity';

const mockSuperAdminUser = {
  id: 'user-admin-001',
  email: 'admin@test.com',
  name: 'Admin User',
  isSuperAdmin: true,
};

const mockRegularUser = {
  id: 'user-regular-001',
  email: 'regular@test.com',
  name: 'Regular User',
  isSuperAdmin: false,
};

describe('WorkspacesService', () => {
  let service: WorkspacesService;
  let clickhouse: jest.Mocked<ClickHouseService>;

  const mockWorkspace: Workspace = {
    id: 'ws-test-001',
    name: 'Test Workspace',
    website: 'https://example.com',
    timezone: 'UTC',
    currency: 'USD',
    logo_url: 'https://example.com/logo.png',
    status: 'active',
    created_at: '2025-01-01 00:00:00',
    updated_at: '2025-01-01 00:00:00',
    settings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
    },
  };

  // ClickHouse stores settings as JSON string
  const mockWorkspaceRow = {
    ...mockWorkspace,
    settings: JSON.stringify(mockWorkspace.settings),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspacesService,
        {
          provide: ClickHouseService,
          useValue: {
            querySystem: jest.fn(),
            insertSystem: jest.fn(),
            commandSystem: jest.fn(),
            commandSystemWithParams: jest.fn(),
            createWorkspaceDatabase: jest.fn(),
            dropWorkspaceDatabase: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-encryption-key'),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WorkspacesService>(WorkspacesService);
    clickhouse = module.get(ClickHouseService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('list', () => {
    describe('for super admin users', () => {
      it('returns all workspaces without filtering', async () => {
        clickhouse.querySystem.mockResolvedValue([mockWorkspaceRow]);

        const result = await service.list(mockSuperAdminUser);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ws-test-001');
        expect(result[0].name).toBe('Test Workspace');
        // Should NOT include membership filter
        expect(clickhouse.querySystem).toHaveBeenCalledWith(
          expect.not.stringContaining('workspace_memberships'),
        );
      });

      it('returns empty array when no workspaces', async () => {
        clickhouse.querySystem.mockResolvedValue([]);

        const result = await service.list(mockSuperAdminUser);

        expect(result).toEqual([]);
      });

      it('parses settings JSON correctly', async () => {
        clickhouse.querySystem.mockResolvedValue([mockWorkspaceRow]);

        const result = await service.list(mockSuperAdminUser);

        expect(result[0].settings).toEqual(mockWorkspace.settings);
        expect(result[0].settings.timescore_reference).toBe(60);
      });
    });

    describe('for regular users', () => {
      it('returns only workspaces where user is a member', async () => {
        clickhouse.querySystem.mockResolvedValue([mockWorkspaceRow]);

        const result = await service.list(mockRegularUser);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ws-test-001');
        // Should include membership filter with user ID
        expect(clickhouse.querySystem).toHaveBeenCalledWith(
          expect.stringContaining('workspace_memberships'),
          { userId: mockRegularUser.id },
        );
      });

      it('returns empty array when user has no memberships', async () => {
        clickhouse.querySystem.mockResolvedValue([]);

        const result = await service.list(mockRegularUser);

        expect(result).toEqual([]);
      });
    });
  });

  describe('get', () => {
    it('returns workspace by ID', async () => {
      clickhouse.querySystem.mockResolvedValue([mockWorkspaceRow]);

      const result = await service.get('ws-test-001');

      expect(result.id).toBe('ws-test-001');
      expect(result.name).toBe('Test Workspace');
      expect(clickhouse.querySystem).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id ='),
        { id: 'ws-test-001' },
      );
    });

    it('throws NotFoundException for non-existent workspace', async () => {
      clickhouse.querySystem.mockResolvedValue([]);

      await expect(service.get('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('creates workspace with default settings', async () => {
      clickhouse.createWorkspaceDatabase.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.create(
        {
          id: 'ws-new-001',
          name: 'New Workspace',
          website: 'https://new.example.com',
          timezone: 'America/New_York',
          currency: 'EUR',
        },
        mockSuperAdminUser,
      );

      expect(result.id).toBe('ws-new-001');
      expect(result.name).toBe('New Workspace');
      expect(result.status).toBe('initializing');
      expect(result.settings.timescore_reference).toBe(60);
      expect(result.settings.bounce_threshold).toBe(10);
    });

    it('creates workspace database before inserting row', async () => {
      clickhouse.createWorkspaceDatabase.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      await service.create(
        {
          id: 'ws-new-001',
          name: 'New Workspace',
          website: 'https://new.example.com',
          timezone: 'UTC',
          currency: 'USD',
        },
        mockSuperAdminUser,
      );

      expect(clickhouse.createWorkspaceDatabase).toHaveBeenCalledWith(
        'ws-new-001',
      );
      expect(clickhouse.insertSystem).toHaveBeenCalledWith(
        'workspaces',
        expect.arrayContaining([expect.objectContaining({ id: 'ws-new-001' })]),
      );
    });

    it('applies custom settings when provided', async () => {
      clickhouse.createWorkspaceDatabase.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.create(
        {
          id: 'ws-new-001',
          name: 'New Workspace',
          website: 'https://new.example.com',
          timezone: 'UTC',
          currency: 'USD',
          settings: {
            timescore_reference: 120,
            bounce_threshold: 5,
          },
        },
        mockSuperAdminUser,
      );

      expect(result.settings.timescore_reference).toBe(120);
      expect(result.settings.bounce_threshold).toBe(5);
    });

    it('seeds allowed_domains from website (ticket allowed-domains-vide)', async () => {
      clickhouse.createWorkspaceDatabase.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.create(
        {
          id: 'ws-new-001',
          name: 'New Workspace',
          website: 'https://www.new.example.com/path',
          timezone: 'UTC',
          currency: 'EUR',
        },
        mockSuperAdminUser,
      );

      // www. collapsed, wildcard covers apex + www + subdomains
      expect(result.settings.allowed_domains).toEqual(['*.new.example.com']);
    });

    it('keeps an explicit empty allowed_domains as allow-all', async () => {
      clickhouse.createWorkspaceDatabase.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.create(
        {
          id: 'ws-new-002',
          name: 'Legacy-style Workspace',
          website: 'https://new.example.com',
          timezone: 'UTC',
          currency: 'EUR',
          settings: { allowed_domains: [] },
        },
        mockSuperAdminUser,
      );

      // Caller opted into "allow all" explicitly — we don't override it.
      expect(result.settings.allowed_domains).toEqual([]);
    });

    it('throws ForbiddenException for non-super_admin user', async () => {
      await expect(
        service.create(
          {
            id: 'ws-new-001',
            name: 'New Workspace',
            website: 'https://new.example.com',
            timezone: 'UTC',
            currency: 'USD',
          },
          mockRegularUser,
        ),
      ).rejects.toThrow(ForbiddenException);

      // Ensure no database operations were performed
      expect(clickhouse.createWorkspaceDatabase).not.toHaveBeenCalled();
      expect(clickhouse.insertSystem).not.toHaveBeenCalled();
    });

    it('adds creator as owner to workspace_memberships', async () => {
      clickhouse.createWorkspaceDatabase.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      await service.create(
        {
          id: 'ws-new-001',
          name: 'New Workspace',
          website: 'https://new.example.com',
          timezone: 'UTC',
          currency: 'USD',
        },
        mockSuperAdminUser,
      );

      // Should insert into workspace_memberships
      expect(clickhouse.insertSystem).toHaveBeenCalledWith(
        'workspace_memberships',
        expect.arrayContaining([
          expect.objectContaining({
            workspace_id: 'ws-new-001',
            user_id: mockSuperAdminUser.id,
            role: 'owner',
            invited_by: null,
          }),
        ]),
      );
    });
  });

  describe('update', () => {
    it('updates workspace properties', async () => {
      clickhouse.querySystem.mockResolvedValue([mockWorkspaceRow]);
      clickhouse.commandSystem.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.update({
        id: 'ws-test-001',
        name: 'Updated Name',
      });

      expect(result.name).toBe('Updated Name');
      expect(result.website).toBe('https://example.com'); // unchanged
    });

    it('merges settings correctly', async () => {
      clickhouse.querySystem.mockResolvedValue([mockWorkspaceRow]);
      clickhouse.commandSystem.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.update({
        id: 'ws-test-001',
        settings: {
          timescore_reference: 180,
        },
      });

      expect(result.settings.timescore_reference).toBe(180);
      expect(result.settings.bounce_threshold).toBe(10); // unchanged
      // Geo settings should be preserved
      expect(result.settings.geo_enabled).toBe(true);
      expect(result.settings.geo_store_city).toBe(true);
      expect(result.settings.geo_store_region).toBe(true);
      expect(result.settings.geo_coordinates_precision).toBe(2);
    });

    it('preserves annotations when updating other settings', async () => {
      const workspaceWithAnnotations = {
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          annotations: [
            {
              id: 'ann-1',
              date: '2025-01-01',
              title: 'Product Launch',
              timezone: 'UTC',
            },
          ],
        },
      };
      const rowWithAnnotations = {
        ...workspaceWithAnnotations,
        settings: JSON.stringify(workspaceWithAnnotations.settings),
      };

      clickhouse.querySystem.mockResolvedValue([rowWithAnnotations]);
      clickhouse.commandSystem.mockResolvedValue(undefined);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.update({
        id: 'ws-test-001',
        name: 'New Name',
      });

      expect(result.settings.annotations).toHaveLength(1);
      expect(result.settings.annotations?.[0].id).toBe('ann-1');
      expect(result.settings.annotations?.[0].title).toBe('Product Launch');
    });

    it('throws NotFoundException for non-existent workspace', async () => {
      clickhouse.querySystem.mockResolvedValue([]);

      await expect(
        service.update({
          id: 'non-existent',
          name: 'Updated',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('updates via INSERT-only (no async DELETE) — ReplacingMergeTree', async () => {
      clickhouse.querySystem.mockResolvedValue([mockWorkspaceRow]);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      await service.update({
        id: 'ws-test-001',
        name: 'Updated',
      });

      // The old DELETE-then-INSERT race is gone: we must NOT emit any
      // `ALTER TABLE … DELETE` on update. A single INSERT supersedes the
      // previous version via the ReplacingMergeTree(updated_at) engine.
      expect(clickhouse.commandSystem).not.toHaveBeenCalled();
      expect(clickhouse.commandSystemWithParams).not.toHaveBeenCalled();
      expect(clickhouse.insertSystem).toHaveBeenCalledWith(
        'workspaces',
        expect.any(Array),
      );
    });

    it('writes a strictly-newer updated_at than the row it merged from', async () => {
      // Same-millisecond updates must not tie on updated_at (the Replacing
      // sort key) — otherwise the engine could keep the OLD version.
      const frozen = '2025-01-01 00:00:00.000';
      const row = {
        ...mockWorkspace,
        updated_at: frozen,
        settings: JSON.stringify(mockWorkspace.settings),
      };
      clickhouse.querySystem.mockResolvedValue([row]);
      clickhouse.insertSystem.mockResolvedValue(undefined);

      const result = await service.update({ id: 'ws-test-001', name: 'X' });

      // New updated_at strictly greater than what we read.
      expect(result.updated_at > frozen).toBe(true);
      const inserted = clickhouse.insertSystem.mock
        .calls[0][1][0] as { updated_at: string };
      expect(inserted.updated_at > frozen).toBe(true);
    });

    // ── Anti-régression P0 : perte de données silencieuse (deep-merge) ──
    // Deux updates rapprochés (off flags puis on un flag) doivent PRÉSERVER
    // l'état du premier. On modélise le ReplacingMergeTree : chaque lecture
    // (`get` → `querySystem`) renvoie la DERNIÈRE version écrite par
    // `insertSystem`. Si on réintroduisait le DELETE+INSERT async, l'état réel
    // serait transitoirement vide et le merge repartirait de {} → ce test
    // (et le flow setFeatures qui s'appuie dessus) casserait.
    it('preserves prior settings across rapid back-to-back updates', async () => {
      // End-to-end contract guard for the setFeatures flow: read state →
      // deep-merge one flag → write must PRESERVE the other flags. Models the
      // store as "last INSERT wins" (ReplacingMergeTree). The async-DELETE race
      // itself can't be reproduced with synchronous mocks (it stems from the
      // mutation being applied lazily after the HTTP 200) — that is locked down
      // by the sibling test asserting update() emits NO DELETE at all. Together:
      // this test proves the merge contract, that one proves the mechanism.
      let visible: typeof mockWorkspaceRow | null = {
        ...mockWorkspace,
        settings: JSON.stringify({
          ...mockWorkspace.settings,
          features: { voip: false, gsc: false, connectors: false },
        }),
      };

      clickhouse.querySystem.mockImplementation((sql: string) => {
        // get() reads the workspace row; other reads (memberships, etc.) n/a here
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve(visible ? [visible] : []);
        }
        return Promise.resolve([]);
      });
      // Model the async DELETE: row becomes invisible to subsequent reads.
      clickhouse.commandSystem.mockImplementation((sql: string) => {
        if (sql.includes('DELETE')) {
          visible = null;
        }
        return Promise.resolve(undefined);
      });
      clickhouse.commandSystemWithParams.mockResolvedValue(undefined);
      // INSERT publishes the new version.
      clickhouse.insertSystem.mockImplementation(
        (_table: string, values: unknown[]) => {
          visible = values[0] as typeof mockWorkspaceRow;
          return Promise.resolve(undefined);
        },
      );

      // Update #1: assert the three flags are persisted false.
      const first = await service.update({
        id: 'ws-test-001',
        settings: {
          features: { voip: false, gsc: false, connectors: false },
        },
      });
      expect(first.settings.features).toEqual({
        voip: false,
        gsc: false,
        connectors: false,
      });

      // Update #2 (rapid, the setFeatures flow): read state, deep-merge voip on,
      // write. The read MUST surface the persisted flags — not an empty window.
      const wsBefore2 = await service.get('ws-test-001');
      const merged = {
        ...(wsBefore2.settings.features ?? {}),
        voip: true,
      };
      const second = await service.update({
        id: 'ws-test-001',
        settings: { features: merged },
      });

      // voip flipped on, gsc + connectors PRESERVED (not wiped).
      expect(second.settings.features).toEqual({
        voip: true,
        gsc: false,
        connectors: false,
      });
    });
  });

  describe('delete', () => {
    it('deletes workspace and all related data (parameterized, injection-safe)', async () => {
      clickhouse.querySystem.mockResolvedValue([{ id: 'ws-test-001' }]);
      clickhouse.dropWorkspaceDatabase.mockResolvedValue(undefined);
      clickhouse.commandSystemWithParams.mockResolvedValue(undefined);

      await service.delete('ws-test-001');

      // All cleanups must be parameterized ({id:String}) — never interpolate
      // the id into raw SQL (SQL-injection defense on the system DB).
      expect(clickhouse.commandSystem).not.toHaveBeenCalled();

      // Verify memberships cleanup
      expect(clickhouse.commandSystemWithParams).toHaveBeenCalledWith(
        expect.stringContaining(
          'workspace_memberships DELETE WHERE workspace_id = {id:String}',
        ),
        { id: 'ws-test-001' },
      );
      // Verify invitations cleanup
      expect(clickhouse.commandSystemWithParams).toHaveBeenCalledWith(
        expect.stringContaining(
          'invitations DELETE WHERE workspace_id = {id:String}',
        ),
        { id: 'ws-test-001' },
      );
      // Verify API keys cleanup
      expect(clickhouse.commandSystemWithParams).toHaveBeenCalledWith(
        expect.stringContaining(
          'api_keys DELETE WHERE workspace_id = {id:String}',
        ),
        { id: 'ws-test-001' },
      );
      // Verify backfill tasks cleanup
      expect(clickhouse.commandSystemWithParams).toHaveBeenCalledWith(
        expect.stringContaining(
          'backfill_tasks DELETE WHERE workspace_id = {id:String}',
        ),
        { id: 'ws-test-001' },
      );
      // Verify database dropped
      expect(clickhouse.dropWorkspaceDatabase).toHaveBeenCalledWith(
        'ws-test-001',
      );
      // Verify workspace row deleted
      expect(clickhouse.commandSystemWithParams).toHaveBeenCalledWith(
        expect.stringContaining('workspaces DELETE WHERE id = {id:String}'),
        { id: 'ws-test-001' },
      );
    });

    it('throws NotFoundException for non-existent workspace', async () => {
      clickhouse.querySystem.mockResolvedValue([]);

      await expect(service.delete('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
