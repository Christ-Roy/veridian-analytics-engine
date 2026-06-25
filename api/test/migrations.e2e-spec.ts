// Set env vars BEFORE any imports to ensure proper configuration
import { setupTestEnv, TEST_SYSTEM_DATABASE } from './constants/test-config';
setupTestEnv();

import { createClient, ClickHouseClient } from '@clickhouse/client';
import { MajorMigration } from '../src/migrations/migration.interface';
import {
  waitForClickHouse,
  waitForMutations,
  waitForData,
} from './helpers/wait.helper';
import { truncateSystemTables } from './helpers/cleanup.helper';
import { toClickHouseDateTime, createTestWorkspace } from './helpers';

// Mock version and registry modules before importing MigrationsRunner
let mockMajorVersion = 2;
let mockMigrations: MajorMigration[] = [];

jest.mock('../src/version', () => ({
  get APP_MAJOR_VERSION() {
    return mockMajorVersion;
  },
  APP_VERSION: '2.4.0',
}));

jest.mock('../src/migrations/migrations.registry', () => ({
  get MIGRATIONS() {
    return mockMigrations;
  },
}));

// Import after mocks are set up
import { MigrationsRunner } from '../src/migrations/migrations.service';
import { V8VoipMigration } from '../src/migrations/v8-voip-migration';
import { V10VisitorIdMigration } from '../src/migrations/v10-visitor-id-migration';
import { V12IdentityAttributionMigration } from '../src/migrations/v12-identity-attribution-migration';
import { WORKSPACE_SCHEMAS } from '../src/database/schemas';

describe('Migrations E2E', () => {
  let systemClient: ClickHouseClient;

  beforeAll(async () => {
    systemClient = createClient({
      url: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
      database: TEST_SYSTEM_DATABASE,
    });
  });

  afterAll(async () => {
    await systemClient.close();
  });

  beforeEach(async () => {
    // Clean system_settings before each test
    await truncateSystemTables(systemClient, ['system_settings']);
    await waitForClickHouse();

    // Reset mock values
    mockMajorVersion = 2;
    mockMigrations = [];
  });

  afterEach(async () => {
    // Clean up any locks left over
    try {
      await systemClient.command({
        query: `ALTER TABLE system_settings DELETE WHERE key = 'migration_lock'`,
      });
      await waitForMutations(systemClient, TEST_SYSTEM_DATABASE);
    } catch {
      // Ignore errors if table doesn't exist
    }

    // Restore setup_completed flag for other tests
    await systemClient.insert({
      table: 'system_settings',
      values: [
        {
          key: 'setup_completed',
          value: 'true',
          updated_at: toClickHouseDateTime(),
        },
      ],
      format: 'JSONEachRow',
    });
    await waitForClickHouse();
  });

  describe('Fresh Install Detection', () => {
    it('sets db_major_version to current version on fresh install', async () => {
      mockMajorVersion = 2;
      mockMigrations = [];

      const runner = new MigrationsRunner();
      const needsRestart = await runner.run();

      expect(needsRestart).toBe(false);

      await waitForClickHouse();

      // Verify version was set
      const result = await systemClient.query({
        query: `SELECT value FROM system_settings FINAL WHERE key = 'db_major_version'`,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ value: string }>();

      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe('2');
    });
  });

  describe('Version Comparison', () => {
    it('returns false when already up to date', async () => {
      // Set current version in DB
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '2',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      mockMajorVersion = 2;
      mockMigrations = [];

      const runner = new MigrationsRunner();
      const needsRestart = await runner.run();

      expect(needsRestart).toBe(false);
    });

    it('throws error on downgrade attempt', async () => {
      // Set DB version higher than code version
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '5',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      mockMajorVersion = 3;
      mockMigrations = [];

      const runner = new MigrationsRunner();

      await expect(runner.run()).rejects.toThrow(
        'Database version (5) is newer than code version (3). Downgrade not supported.',
      );
    });
  });

  describe('System Migration Execution', () => {
    it('runs system migration and updates version', async () => {
      // Set DB at version 1
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '1',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      const migrateSystemMock = jest.fn().mockResolvedValue(undefined);
      const mockMigration: MajorMigration = {
        majorVersion: 2,
        hasSystemMigration: () => true,
        hasWorkspaceMigration: () => false,
        migrateSystem: migrateSystemMock,
        migrateWorkspace: jest.fn(),
      };

      mockMajorVersion = 2;
      mockMigrations = [mockMigration];

      const runner = new MigrationsRunner();
      const needsRestart = await runner.run();

      expect(needsRestart).toBe(true);
      expect(migrateSystemMock).toHaveBeenCalledTimes(1);
      expect(migrateSystemMock).toHaveBeenCalledWith(
        expect.anything(), // ClickHouse client
        TEST_SYSTEM_DATABASE,
      );

      await waitForClickHouse();

      // Verify version was updated
      const result = await systemClient.query({
        query: `SELECT value FROM system_settings FINAL WHERE key = 'db_major_version'`,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ value: string }>();

      expect(rows[0].value).toBe('2');
    });

    it('executes actual SQL migration commands', async () => {
      // Set DB at version 1
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '1',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      // Create a migration that adds a test setting
      const mockMigration: MajorMigration = {
        majorVersion: 2,
        hasSystemMigration: () => true,
        hasWorkspaceMigration: () => false,
        migrateSystem: async (client, systemDb) => {
          await client.insert({
            table: `${systemDb}.system_settings`,
            values: [
              {
                key: 'migration_test_key',
                value: 'migration_test_value',
                updated_at: new Date()
                  .toISOString()
                  .replace('T', ' ')
                  .slice(0, 23),
              },
            ],
            format: 'JSONEachRow',
          });
        },
        migrateWorkspace: jest.fn(),
      };

      mockMajorVersion = 2;
      mockMigrations = [mockMigration];

      const runner = new MigrationsRunner();
      await runner.run();

      await waitForClickHouse();

      // Verify migration created the test setting
      const result = await systemClient.query({
        query: `SELECT value FROM system_settings FINAL WHERE key = 'migration_test_key'`,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ value: string }>();

      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe('migration_test_value');
    });
  });

  describe('V8 VoIP Migration', () => {
    // The real V8 migration is additive (system-only): it creates the
    // voip_credentials + tenant_phone_numbers tables. We run its actual
    // migrateSystem against the test system DB and assert both tables exist
    // with the expected columns. CREATE TABLE IF NOT EXISTS = idempotent.
    it('creates voip_credentials and tenant_phone_numbers tables', async () => {
      expect(V8VoipMigration.majorVersion).toBe(8);
      expect(V8VoipMigration.hasSystemMigration()).toBe(true);
      expect(V8VoipMigration.hasWorkspaceMigration()).toBe(false);

      await V8VoipMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);
      await waitForClickHouse();

      const tables = await systemClient.query({
        query: `SELECT name FROM system.tables
                WHERE database = {db:String}
                  AND name IN ('voip_credentials', 'tenant_phone_numbers')
                ORDER BY name`,
        query_params: { db: TEST_SYSTEM_DATABASE },
        format: 'JSONEachRow',
      });
      const names = (await tables.json<{ name: string }>()).map((r) => r.name);
      expect(names).toEqual(['tenant_phone_numbers', 'voip_credentials']);

      const cols = await systemClient.query({
        query: `SELECT name FROM system.columns
                WHERE database = {db:String} AND table = 'voip_credentials'`,
        query_params: { db: TEST_SYSTEM_DATABASE },
        format: 'JSONEachRow',
      });
      const colNames = (await cols.json<{ name: string }>()).map((r) => r.name);
      expect(colNames).toEqual(
        expect.arrayContaining([
          'id',
          'workspace_id',
          'kind',
          'creds_encrypted',
          'status',
          'last_sync_at',
          'deleted_at',
        ]),
      );
    });

    it('is idempotent (running twice does not throw)', async () => {
      await V8VoipMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);
      await V8VoipMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);
      await waitForClickHouse();
      // No-op workspace migration must resolve without error.
      await expect(
        V8VoipMigration.migrateWorkspace(systemClient, TEST_SYSTEM_DATABASE),
      ).resolves.toBeUndefined();
    });
  });

  describe('V10 Visitor ID Migration', () => {
    // The real V10 migration is additive (workspace-level): it adds
    // visitor_id / fingerprint / ip to events, sessions, pages, goals and
    // recreates the 3 MVs so the columns flow events → sessions/pages/goals.
    // We build a workspace DB WITHOUT the new columns (simulating a v9 install),
    // run the actual migrateWorkspace, and assert the columns now exist on every
    // table AND that the recreated sessions_mv propagates visitor_id end-to-end.
    const V10_DB = `${TEST_SYSTEM_DATABASE}_ws_v10`;

    afterAll(async () => {
      await systemClient.command({
        query: `DROP DATABASE IF EXISTS ${V10_DB}`,
      });
    });

    /**
     * Strip the 3 B2B columns + their bloom-filter index from a real schema DDL
     * so the table looks like a pre-v10 install. We build the BASE tables from
     * the canonical WORKSPACE_SCHEMAS (so they carry EVERY column the MVs read)
     * minus visitor_id/fingerprint/ip — exactly the upgrade path V10 covers.
     */
    function stripB2bColumns(ddl: string): string {
      return ddl
        .replace(/^\s*(?:visitor_id|fingerprint|ip)\s+String\s+DEFAULT\s+''\s*,?\s*$/gim, '')
        .replace(/^\s*INDEX\s+idx_visitor_id[^\n]*,?\s*$/gim, '')
        // Tidy any trailing comma left dangling before the closing paren.
        .replace(/,(\s*)\)/g, '$1)');
    }

    /**
     * Build the events + sessions + pages + goals BASE tables (no MVs — the
     * migration recreates those) from the real schemas, stripped of the B2B
     * columns. Simulates a v9 install ready for the V10 upgrade.
     */
    async function buildPreV10Schema(): Promise<void> {
      await systemClient.command({ query: `DROP DATABASE IF EXISTS ${V10_DB}` });
      await systemClient.command({ query: `CREATE DATABASE ${V10_DB}` });

      for (const table of ['events', 'sessions', 'pages', 'goals'] as const) {
        const ddl = stripB2bColumns(
          WORKSPACE_SCHEMAS[table].replace(/{database}/g, V10_DB),
        );
        await systemClient.command({ query: ddl });
      }
      await waitForClickHouse();
    }

    it('declares itself a workspace-level migration to version 10', () => {
      expect(V10VisitorIdMigration.majorVersion).toBe(10);
      expect(V10VisitorIdMigration.hasWorkspaceMigration()).toBe(true);
      expect(V10VisitorIdMigration.hasSystemMigration()).toBe(false);
    });

    it('adds visitor_id/fingerprint/ip to events and recreates sessions_mv', async () => {
      await buildPreV10Schema();

      // Pre-condition: events table lacks the 3 columns.
      const before = await systemClient.query({
        query: `SELECT name FROM system.columns
                WHERE database = {db:String} AND table = 'events'
                  AND name IN ('visitor_id','fingerprint','ip')`,
        query_params: { db: V10_DB },
        format: 'JSONEachRow',
      });
      expect((await before.json<{ name: string }>()).length).toBe(0);

      // Run the real workspace migration.
      await V10VisitorIdMigration.migrateWorkspace(systemClient, V10_DB);
      await waitForClickHouse();

      // events now carries the 3 B2B columns.
      const cols = await systemClient.query({
        query: `SELECT name FROM system.columns
                WHERE database = {db:String} AND table = 'events'`,
        query_params: { db: V10_DB },
        format: 'JSONEachRow',
      });
      const colNames = (await cols.json<{ name: string }>()).map((r) => r.name);
      expect(colNames).toEqual(
        expect.arrayContaining(['visitor_id', 'fingerprint', 'ip']),
      );

      // sessions_mv exists again (recreated) and selects visitor_id.
      const mv = await systemClient.query({
        query: `SELECT count() AS c FROM system.tables
                WHERE database = {db:String} AND name = 'sessions_mv'`,
        query_params: { db: V10_DB },
        format: 'JSONEachRow',
      });
      expect(Number((await mv.json<{ c: number }>())[0]?.c ?? 0)).toBe(1);
    });

    it('propagates visitor_id from events to sessions via the recreated MV', async () => {
      await buildPreV10Schema();
      await V10VisitorIdMigration.migrateWorkspace(systemClient, V10_DB);
      await waitForClickHouse();

      // Insert a screen_view carrying a visitor_id — the MV must fan it out.
      const now = toClickHouseDateTime();
      await systemClient.insert({
        table: `${V10_DB}.events`,
        values: [
          {
            session_id: 'sess_v10',
            workspace_id: 'ws_v10',
            received_at: now,
            created_at: now,
            updated_at: now,
            name: 'screen_view',
            path: '/',
            page_number: 1,
            dedup_token: 'sess_v10_pv_1',
            visitor_id: 'visitor_v10_abc',
            fingerprint: 'fp_v10',
            ip: '203.0.113.7',
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForData(
        systemClient,
        `${V10_DB}.sessions`,
        "id = 'sess_v10'",
        {},
        { timeoutMs: 3000, intervalMs: 50 },
      );

      const res = await systemClient.query({
        query: `SELECT visitor_id, fingerprint, ip
                FROM ${V10_DB}.sessions FINAL WHERE id = 'sess_v10'`,
        format: 'JSONEachRow',
      });
      const row = (
        await res.json<{ visitor_id: string; fingerprint: string; ip: string }>()
      )[0];
      expect(row?.visitor_id).toBe('visitor_v10_abc');
      expect(row?.fingerprint).toBe('fp_v10');
      expect(row?.ip).toBe('203.0.113.7');
    });

    it('is idempotent (running twice does not throw)', async () => {
      await buildPreV10Schema();
      await V10VisitorIdMigration.migrateWorkspace(systemClient, V10_DB);
      await expect(
        V10VisitorIdMigration.migrateWorkspace(systemClient, V10_DB),
      ).resolves.toBeUndefined();
    });
  });

  describe('Workspace Migration Execution', () => {
    it('runs workspace migration for each workspace', async () => {
      // Create test workspaces
      await truncateSystemTables(systemClient, ['workspaces']);
      await createTestWorkspace(systemClient, 'ws_migration_1', {
        name: 'Migration Test 1',
      });
      await createTestWorkspace(systemClient, 'ws_migration_2', {
        name: 'Migration Test 2',
      });
      await waitForClickHouse();

      // Set DB at version 1
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '1',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      const migrateWorkspaceMock = jest.fn().mockResolvedValue(undefined);
      const mockMigration: MajorMigration = {
        majorVersion: 2,
        hasSystemMigration: () => false,
        hasWorkspaceMigration: () => true,
        migrateSystem: jest.fn(),
        migrateWorkspace: migrateWorkspaceMock,
      };

      mockMajorVersion = 2;
      mockMigrations = [mockMigration];

      const runner = new MigrationsRunner();
      const needsRestart = await runner.run();

      expect(needsRestart).toBe(true);
      expect(migrateWorkspaceMock).toHaveBeenCalledTimes(2);
      // Check workspace database names (sanitized)
      expect(migrateWorkspaceMock).toHaveBeenCalledWith(
        expect.anything(),
        'staminads_ws_ws_migration_1',
      );
      expect(migrateWorkspaceMock).toHaveBeenCalledWith(
        expect.anything(),
        'staminads_ws_ws_migration_2',
      );

      // Cleanup
      await truncateSystemTables(systemClient, ['workspaces']);
    });

    it('aborts on first workspace migration failure', async () => {
      // Create test workspaces
      await truncateSystemTables(systemClient, ['workspaces']);
      await createTestWorkspace(systemClient, 'ws_fail_1', {
        name: 'Fail Test 1',
      });
      await createTestWorkspace(systemClient, 'ws_fail_2', {
        name: 'Fail Test 2',
      });
      await waitForClickHouse();

      // Set DB at version 1
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '1',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      const migrateWorkspaceMock = jest
        .fn()
        .mockResolvedValueOnce(undefined) // First workspace succeeds
        .mockRejectedValueOnce(new Error('Workspace migration failed')); // Second fails

      const mockMigration: MajorMigration = {
        majorVersion: 2,
        hasSystemMigration: () => false,
        hasWorkspaceMigration: () => true,
        migrateSystem: jest.fn(),
        migrateWorkspace: migrateWorkspaceMock,
      };

      mockMajorVersion = 2;
      mockMigrations = [mockMigration];

      const runner = new MigrationsRunner();

      await expect(runner.run()).rejects.toThrow('Workspace migration failed');

      // Version should NOT have been updated (migration failed)
      const result = await systemClient.query({
        query: `SELECT value FROM system_settings FINAL WHERE key = 'db_major_version'`,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ value: string }>();
      expect(rows[0].value).toBe('1');

      // Cleanup
      await truncateSystemTables(systemClient, ['workspaces']);
    });
  });

  describe('Incremental Upgrades', () => {
    it('runs only one migration per execution', async () => {
      // Set DB at version 1, code at version 4
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '1',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      const v2Mock = jest.fn().mockResolvedValue(undefined);
      const v3Mock = jest.fn().mockResolvedValue(undefined);
      const v4Mock = jest.fn().mockResolvedValue(undefined);

      const migrations: MajorMigration[] = [
        {
          majorVersion: 2,
          hasSystemMigration: () => true,
          hasWorkspaceMigration: () => false,
          migrateSystem: v2Mock,
          migrateWorkspace: jest.fn(),
        },
        {
          majorVersion: 3,
          hasSystemMigration: () => true,
          hasWorkspaceMigration: () => false,
          migrateSystem: v3Mock,
          migrateWorkspace: jest.fn(),
        },
        {
          majorVersion: 4,
          hasSystemMigration: () => true,
          hasWorkspaceMigration: () => false,
          migrateSystem: v4Mock,
          migrateWorkspace: jest.fn(),
        },
      ];

      mockMajorVersion = 4;
      mockMigrations = migrations;

      const runner = new MigrationsRunner();
      const needsRestart = await runner.run();

      expect(needsRestart).toBe(true);
      // Only v2 should have run
      expect(v2Mock).toHaveBeenCalledTimes(1);
      expect(v3Mock).not.toHaveBeenCalled();
      expect(v4Mock).not.toHaveBeenCalled();

      await waitForClickHouse();

      // Version should be 2 (not 4)
      const result = await systemClient.query({
        query: `SELECT value FROM system_settings FINAL WHERE key = 'db_major_version'`,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ value: string }>();
      expect(rows[0].value).toBe('2');
    });
  });

  describe('Lock Behavior', () => {
    it('acquires and releases lock during migration', async () => {
      mockMajorVersion = 2;
      mockMigrations = [];

      const runner = new MigrationsRunner();
      await runner.run();

      await waitForClickHouse();
      await waitForMutations(systemClient, TEST_SYSTEM_DATABASE);

      // Lock should be released after migration
      const result = await systemClient.query({
        query: `SELECT value FROM system_settings FINAL WHERE key = 'migration_lock'`,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ value: string }>();

      expect(rows).toHaveLength(0);
    });

    it('exits when lock is held by another instance', async () => {
      // Insert an active lock
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'migration_lock',
            value: 'other-instance-123',
            updated_at: toClickHouseDateTime(), // Recent lock
          },
        ],
        format: 'JSONEachRow',
      });
      // Wait for the lock to be visible in ClickHouse (FINAL requires merge)
      await waitForData(
        systemClient,
        'system_settings',
        "key = 'migration_lock'",
      );

      mockMajorVersion = 2;
      mockMigrations = [];

      const runner = new MigrationsRunner();
      const needsRestart = await runner.run();

      // Should signal restart (another instance is handling migrations)
      expect(needsRestart).toBe(true);
    });

    it('takes over expired lock', async () => {
      // Insert an expired lock (10 minutes ago)
      const expiredTime = new Date(Date.now() - 10 * 60 * 1000);
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'migration_lock',
            value: 'expired-instance-123',
            updated_at: expiredTime
              .toISOString()
              .replace('T', ' ')
              .slice(0, 23),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      mockMajorVersion = 2;
      mockMigrations = [];

      const runner = new MigrationsRunner();
      const needsRestart = await runner.run();

      // Should proceed with fresh install logic
      expect(needsRestart).toBe(false);
    });
  });

  describe('Combined System and Workspace Migration', () => {
    it('runs system migration before workspace migrations', async () => {
      // Create test workspace
      await truncateSystemTables(systemClient, ['workspaces']);
      await createTestWorkspace(systemClient, 'ws_combined', {
        name: 'Combined Test',
      });
      await waitForClickHouse();

      // Set DB at version 1
      await systemClient.insert({
        table: 'system_settings',
        values: [
          {
            key: 'db_major_version',
            value: '1',
            updated_at: toClickHouseDateTime(),
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      const callOrder: string[] = [];
      const mockMigration: MajorMigration = {
        majorVersion: 2,
        hasSystemMigration: () => true,
        hasWorkspaceMigration: () => true,
        migrateSystem: jest.fn().mockImplementation(async () => {
          callOrder.push('system');
        }),
        migrateWorkspace: jest.fn().mockImplementation(async () => {
          callOrder.push('workspace');
        }),
      };

      mockMajorVersion = 2;
      mockMigrations = [mockMigration];

      const runner = new MigrationsRunner();
      await runner.run();

      // System migration should run first
      expect(callOrder).toEqual(['system', 'workspace']);

      // Cleanup
      await truncateSystemTables(systemClient, ['workspaces']);
    });
  });

  describe('V7 Webhooks Migration', () => {
    // Static import here on purpose: the migrations runner is mocked above,
    // we test the migration object in isolation against a real ClickHouse.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { V7WebhooksMigration } = require('../src/migrations/v7-webhooks-migration');

    it('creates webhook_definitions and webhook_deliveries tables', async () => {
      // Drop the tables first to ensure migrateSystem creates them.
      await systemClient.command({ query: `DROP TABLE IF EXISTS webhook_definitions` });
      await systemClient.command({ query: `DROP TABLE IF EXISTS webhook_deliveries` });

      await V7WebhooksMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);

      const result = await systemClient.query({
        query: `SELECT name FROM system.tables WHERE database = {db:String} AND name IN ('webhook_definitions', 'webhook_deliveries') ORDER BY name`,
        query_params: { db: TEST_SYSTEM_DATABASE },
        format: 'JSONEachRow',
      });
      const tables = (await result.json<{ name: string }>()).map((r) => r.name);
      expect(tables).toContain('webhook_definitions');
      expect(tables).toContain('webhook_deliveries');
    });

    it('is idempotent (running twice does not throw)', async () => {
      await V7WebhooksMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);
      await V7WebhooksMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);
    });

    it('declares system-only migration (no workspace iteration)', () => {
      expect(V7WebhooksMigration.majorVersion).toBe(7);
      expect(V7WebhooksMigration.hasSystemMigration()).toBe(true);
      expect(V7WebhooksMigration.hasWorkspaceMigration()).toBe(false);
    });
  });

  describe('V9 GSC Migration', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { V9GscMigration } = require('../src/migrations/v9-gsc-migration');

    it('creates gsc_property and gsc_daily tables', async () => {
      await systemClient.command({ query: `DROP TABLE IF EXISTS gsc_property` });
      await systemClient.command({ query: `DROP TABLE IF EXISTS gsc_daily` });

      await V9GscMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);

      const result = await systemClient.query({
        query: `SELECT name FROM system.tables WHERE database = {db:String} AND name IN ('gsc_property', 'gsc_daily') ORDER BY name`,
        query_params: { db: TEST_SYSTEM_DATABASE },
        format: 'JSONEachRow',
      });
      const tables = (await result.json<{ name: string }>()).map((r) => r.name);
      expect(tables).toContain('gsc_property');
      expect(tables).toContain('gsc_daily');
    });

    it('is idempotent (running twice does not throw)', async () => {
      await V9GscMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);
      await V9GscMigration.migrateSystem(systemClient, TEST_SYSTEM_DATABASE);
    });

    it('declares system-only migration (no workspace iteration)', () => {
      expect(V9GscMigration.majorVersion).toBe(9);
      expect(V9GscMigration.hasSystemMigration()).toBe(true);
      expect(V9GscMigration.hasWorkspaceMigration()).toBe(false);
    });
  });

  describe('V11 Workspaces ReplacingMergeTree Migration', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      V11WorkspacesReplacingMigration,
    } = require('../src/migrations/v11-workspaces-replacing-migration');

    /**
     * Build a `workspaces` system table with the OLD plain MergeTree engine and
     * a duplicate row for the same id (two versions, older + newer) — exactly
     * the v10 state V11 must convert and dedup.
     */
    async function buildPreV11Workspaces(): Promise<void> {
      await systemClient.command({
        query: `DROP TABLE IF EXISTS ${TEST_SYSTEM_DATABASE}.workspaces`,
      });
      await systemClient.command({
        query: `
          CREATE TABLE ${TEST_SYSTEM_DATABASE}.workspaces (
            id String, name String, website String, timezone String,
            currency String, logo_url Nullable(String),
            settings String DEFAULT '{}',
            status Enum8('initializing'=1,'active'=2,'inactive'=3,'error'=4),
            created_at DateTime64(3) DEFAULT now64(3),
            updated_at DateTime64(3) DEFAULT now64(3)
          ) ENGINE = MergeTree() ORDER BY id
        `,
      });
      // Older version (settings A) then newer version (settings B) of one id.
      await systemClient.insert({
        table: `${TEST_SYSTEM_DATABASE}.workspaces`,
        values: [
          {
            id: 'ws_v11',
            name: 'V11',
            website: 'https://v11.example.com',
            timezone: 'Europe/Paris',
            currency: 'EUR',
            logo_url: null,
            settings: '{"features":{"voip":false}}',
            status: 'active',
            created_at: '2025-01-01 00:00:00.000',
            updated_at: '2025-01-01 00:00:00.000',
          },
          {
            id: 'ws_v11',
            name: 'V11',
            website: 'https://v11.example.com',
            timezone: 'Europe/Paris',
            currency: 'EUR',
            logo_url: null,
            settings: '{"features":{"voip":true,"gsc":true}}',
            status: 'active',
            created_at: '2025-01-01 00:00:00.000',
            updated_at: '2025-01-02 00:00:00.000',
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();
    }

    it('declares system-only migration to version 11', () => {
      expect(V11WorkspacesReplacingMigration.majorVersion).toBe(11);
      expect(V11WorkspacesReplacingMigration.hasSystemMigration()).toBe(true);
      expect(V11WorkspacesReplacingMigration.hasWorkspaceMigration()).toBe(
        false,
      );
    });

    it('converts workspaces MergeTree → ReplacingMergeTree and dedups', async () => {
      await buildPreV11Workspaces();

      // Sanity: pre-migration engine is plain MergeTree with 2 rows for the id.
      const before = await systemClient.query({
        query: `SELECT engine FROM system.tables
                WHERE database = {db:String} AND name = 'workspaces'`,
        query_params: { db: TEST_SYSTEM_DATABASE },
        format: 'JSONEachRow',
      });
      expect((await before.json<{ engine: string }>())[0].engine).toBe(
        'MergeTree',
      );

      await V11WorkspacesReplacingMigration.migrateSystem(
        systemClient,
        TEST_SYSTEM_DATABASE,
      );
      await waitForClickHouse();

      // Engine is now ReplacingMergeTree.
      const after = await systemClient.query({
        query: `SELECT engine FROM system.tables
                WHERE database = {db:String} AND name = 'workspaces'`,
        query_params: { db: TEST_SYSTEM_DATABASE },
        format: 'JSONEachRow',
      });
      expect((await after.json<{ engine: string }>())[0].engine).toBe(
        'ReplacingMergeTree',
      );

      // Exactly one row survives, and it is the NEWEST version (settings B).
      const rows = await systemClient.query({
        query: `SELECT settings FROM ${TEST_SYSTEM_DATABASE}.workspaces
                WHERE id = 'ws_v11'`,
        format: 'JSONEachRow',
      });
      const settings = (await rows.json<{ settings: string }>()).map(
        (r) => r.settings,
      );
      expect(settings).toHaveLength(1);
      expect(settings[0]).toContain('"gsc":true');

      // The temporary swap table must be gone.
      const tmp = await systemClient.query({
        query: `SELECT count() AS c FROM system.tables
                WHERE database = {db:String} AND name = 'workspaces_v11'`,
        query_params: { db: TEST_SYSTEM_DATABASE },
        format: 'JSONEachRow',
      });
      expect((await tmp.json<{ c: string }>())[0].c).toBe('0');
    });

    it('no-op workspace migration resolves without error', async () => {
      await expect(
        V11WorkspacesReplacingMigration.migrateWorkspace(),
      ).resolves.toBeUndefined();
    });
  });

  describe('V12 Identity Attribution Migration', () => {
    // V12 is additive (workspace-level): it creates the user_attribution table,
    // adds first_touch_channel / first_touch_channel_group to sessions + goals,
    // and recreates sessions_mv / goals_mv so the new columns flow (empty) from
    // events. We build a workspace DB WITHOUT any of that (simulating a v11
    // install), run the real migrateWorkspace, and assert the additive result.
    const V12_DB = `${TEST_SYSTEM_DATABASE}_ws_v12`;

    afterAll(async () => {
      await systemClient.command({
        query: `DROP DATABASE IF EXISTS ${V12_DB}`,
      });
    });

    /** Strip the first_touch_* columns so the table looks like a pre-v12 install. */
    function stripFirstTouchColumns(ddl: string): string {
      return ddl
        .replace(
          /^\s*(?:first_touch_channel|first_touch_channel_group)\s+LowCardinality\(String\)\s+DEFAULT\s+''\s*,?\s*$/gim,
          '',
        )
        .replace(
          /CAST\('' AS LowCardinality\(String\)\) as (?:first_touch_channel|first_touch_channel_group),?\s*/gim,
          '',
        )
        .replace(/,(\s*)\)/g, '$1)');
    }

    /**
     * Build events + sessions + goals + their MVs from the real schemas, stripped
     * of first_touch_* and WITHOUT user_attribution. Simulates a v11 install.
     */
    async function buildPreV12Schema(): Promise<void> {
      await systemClient.command({ query: `DROP DATABASE IF EXISTS ${V12_DB}` });
      await systemClient.command({ query: `CREATE DATABASE ${V12_DB}` });

      // Order matters: base tables before their MVs.
      for (const table of [
        'events',
        'sessions',
        'sessions_mv',
        'goals',
        'goals_mv',
      ] as const) {
        const ddl = stripFirstTouchColumns(
          WORKSPACE_SCHEMAS[table].replace(/{database}/g, V12_DB),
        );
        await systemClient.command({ query: ddl });
      }
      await waitForClickHouse();
    }

    it('declares itself a workspace-level migration to version 12', () => {
      expect(V12IdentityAttributionMigration.majorVersion).toBe(12);
      expect(V12IdentityAttributionMigration.hasWorkspaceMigration()).toBe(true);
      expect(V12IdentityAttributionMigration.hasSystemMigration()).toBe(false);
    });

    it('creates user_attribution and adds first_touch_* to sessions + goals', async () => {
      await buildPreV12Schema();

      // Pre-condition: no user_attribution table, no first_touch columns.
      const beforeTable = await systemClient.query({
        query: `SELECT count() AS c FROM system.tables
                WHERE database = {db:String} AND name = 'user_attribution'`,
        query_params: { db: V12_DB },
        format: 'JSONEachRow',
      });
      expect(Number((await beforeTable.json<{ c: number }>())[0]?.c ?? 0)).toBe(
        0,
      );

      await V12IdentityAttributionMigration.migrateWorkspace(
        systemClient,
        V12_DB,
      );
      await waitForClickHouse();

      // user_attribution now exists, ReplacingMergeTree, keyed by identity_key.
      const tbl = await systemClient.query({
        query: `SELECT engine FROM system.tables
                WHERE database = {db:String} AND name = 'user_attribution'`,
        query_params: { db: V12_DB },
        format: 'JSONEachRow',
      });
      const engineRows = await tbl.json<{ engine: string }>();
      expect(engineRows.length).toBe(1);
      expect(engineRows[0].engine).toBe('ReplacingMergeTree');

      // first_touch_* present on sessions AND goals.
      for (const table of ['sessions', 'goals']) {
        const cols = await systemClient.query({
          query: `SELECT name FROM system.columns
                  WHERE database = {db:String} AND table = {t:String}`,
          query_params: { db: V12_DB, t: table },
          format: 'JSONEachRow',
        });
        const names = (await cols.json<{ name: string }>()).map((r) => r.name);
        expect(names).toEqual(
          expect.arrayContaining([
            'first_touch_channel',
            'first_touch_channel_group',
          ]),
        );
      }
    });

    it('total-preserving: existing sessions survive the additive migration', async () => {
      await buildPreV12Schema();

      // Seed a session BEFORE migrating.
      const now = toClickHouseDateTime();
      await systemClient.insert({
        table: `${V12_DB}.sessions`,
        values: [
          {
            id: 'sess_v12',
            workspace_id: 'ws_v12',
            created_at: now,
            updated_at: now,
            is_direct: true,
            landing_page: 'https://test.com/',
            year: 2026,
            month: 6,
            day: 25,
            day_of_week: 4,
            week_number: 26,
            hour: 10,
            is_weekend: false,
            channel: 'organic_search',
            channel_group: 'seo',
          },
        ],
        format: 'JSONEachRow',
      });
      await waitForClickHouse();

      await V12IdentityAttributionMigration.migrateWorkspace(
        systemClient,
        V12_DB,
      );
      await waitForClickHouse();

      // The row survives, its existing channel untouched, first_touch empty.
      const res = await systemClient.query({
        query: `SELECT channel_group, first_touch_channel_group
                FROM ${V12_DB}.sessions FINAL WHERE id = 'sess_v12'`,
        format: 'JSONEachRow',
      });
      const rows = await res.json<{
        channel_group: string;
        first_touch_channel_group: string;
      }>();
      expect(rows.length).toBe(1);
      expect(rows[0].channel_group).toBe('seo');
      expect(rows[0].first_touch_channel_group).toBe('');
    });

    it('is idempotent (running twice does not throw)', async () => {
      await buildPreV12Schema();
      await V12IdentityAttributionMigration.migrateWorkspace(
        systemClient,
        V12_DB,
      );
      await expect(
        V12IdentityAttributionMigration.migrateWorkspace(systemClient, V12_DB),
      ).resolves.toBeUndefined();
    });
  });
});
