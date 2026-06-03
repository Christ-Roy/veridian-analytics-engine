import { ClickHouseClient } from '@clickhouse/client';
import { MajorMigration } from './migration.interface';

/**
 * V7 Webhooks Migration
 *
 * Creates the webhook_definitions and webhook_deliveries tables in the
 * system database. Enables the multi-tenant webhook destinations module:
 * - workspace operators can register N webhooks per workspace
 * - each event tracked via /api/track can fan out to matching webhooks
 * - delivery attempts (success + retries) are persisted for traceability
 *
 * Choices:
 * - Storage: ClickHouse `staminads_system` (cf PATTERNS-WEBHOOKS.md §3)
 *   no FOREIGN KEY / UNIQUE — unicity (workspace_id, name) enforced
 *   in the service layer.
 * - `webhook_definitions` uses ReplacingMergeTree(updated_at) to support
 *   updates with the same id (same pattern as api_keys).
 * - `webhook_deliveries` uses plain MergeTree with TTL 30 days for
 *   automatic cleanup.
 *
 * Fresh installs get these tables via SYSTEM_SCHEMAS in
 * `database/schemas.ts` (initSystemDatabase). This migration covers the
 * upgrade path for existing installs at major version 6.
 */
export const V7WebhooksMigration: MajorMigration = {
  majorVersion: 7,

  hasSystemMigration(): boolean {
    return true;
  },

  hasWorkspaceMigration(): boolean {
    return false;
  },

  async migrateSystem(
    client: ClickHouseClient,
    systemDb: string,
  ): Promise<void> {
    console.log('[V7 Migration] Creating webhook_definitions table...');
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.webhook_definitions (
          id String,
          workspace_id String,
          name String,
          url String,
          active UInt8 DEFAULT 1,
          auth_type Enum8('none' = 0, 'bearer' = 1, 'basic' = 2, 'hmac' = 3) DEFAULT 'none',
          auth_secret String DEFAULT '',
          events String DEFAULT '[]',
          filters String DEFAULT '[]',
          transform String DEFAULT '',
          retry_config String DEFAULT '',
          created_at DateTime64(3) DEFAULT now64(3),
          updated_at DateTime64(3) DEFAULT now64(3),
          deleted_at Nullable(DateTime64(3))
        ) ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY (workspace_id, id)
      `,
    });

    console.log('[V7 Migration] Creating webhook_deliveries table...');
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.webhook_deliveries (
          id String,
          webhook_id String,
          workspace_id String,
          event_id String,
          event_type String,
          attempt UInt8 DEFAULT 1,
          scheduled_at DateTime64(3),
          sent_at Nullable(DateTime64(3)),
          status Enum8('pending' = 0, 'success' = 1, 'failed' = 2, 'retrying' = 3, 'gave_up' = 4) DEFAULT 'pending',
          http_status Nullable(UInt16),
          latency_ms Nullable(UInt32),
          request_url String DEFAULT '',
          request_body String DEFAULT '',
          response_body String DEFAULT '',
          error_message String DEFAULT '',
          created_at DateTime64(3) DEFAULT now64(3),
          updated_at DateTime64(3) DEFAULT now64(3)
        ) ENGINE = ReplacingMergeTree(updated_at)
        PARTITION BY toYYYYMM(created_at)
        ORDER BY (workspace_id, webhook_id, id)
        TTL toDateTime(created_at) + INTERVAL 30 DAY DELETE
      `,
    });

    console.log('[V7 Migration] webhook tables created');
  },

  async migrateWorkspace(): Promise<void> {
    // No workspace-level changes
  },
};
