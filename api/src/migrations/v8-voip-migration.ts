import { ClickHouseClient } from '@clickhouse/client';
import { MajorMigration } from './migration.interface';

/**
 * V8 VoIP Migration
 *
 * Creates the voip_credentials and tenant_phone_numbers tables in the system
 * database. Enables the native VoIP connector (port natif du bridge VoIP, cf
 * todo/2026-06-16-port-natif-voip.md) :
 * - workspace operators connect OVH / Telnyx in Settings → VoIP tab
 * - a native @Cron pulls CDR and pushes each call as a `phone_call` goal event
 *   (internal EventBufferService) → visible in Live / Explore / Goals natively
 * - 1 numéro = 1 source (tenant_phone_numbers) enriches each event's
 *   properties.source dimension (vision 2026-05-25)
 *
 * Choices (cf V7 webhooks migration) :
 * - Storage: ClickHouse `staminads_system`, no FOREIGN KEY / UNIQUE — unicity
 *   ((workspace_id, kind) for creds, (workspace_id, e164) for numbers) enforced
 *   in the service layer.
 * - Both tables use ReplacingMergeTree(updated_at) to support upserts with the
 *   same key (same pattern as api_keys / webhook_definitions).
 * - creds_encrypted is an AES-256-GCM blob (clé-par-workspace, common/crypto) :
 *   the clear-text VoIP secret NEVER lands in DB.
 *
 * Fresh installs get these tables via SYSTEM_SCHEMAS in `database/schemas.ts`
 * (initSystemDatabase). This migration covers the upgrade path for existing
 * installs at major version 7. ADDITIVE migration (no data loss).
 */
export const V8VoipMigration: MajorMigration = {
  majorVersion: 8,

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
    console.log('[V8 Migration] Creating voip_credentials table...');
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.voip_credentials (
          id String,
          workspace_id String,
          kind Enum8('voip_ovh' = 1, 'voip_telnyx' = 2),
          creds_encrypted String,
          status Enum8('untested' = 1, 'ok' = 2, 'failed' = 3) DEFAULT 'untested',
          last_sync_at Nullable(DateTime64(3)),
          last_tested_at Nullable(DateTime64(3)),
          last_error String DEFAULT '',
          created_at DateTime64(3) DEFAULT now64(3),
          updated_at DateTime64(3) DEFAULT now64(3),
          deleted_at Nullable(DateTime64(3))
        ) ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY (workspace_id, kind)
      `,
    });

    console.log('[V8 Migration] Creating tenant_phone_numbers table...');
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.tenant_phone_numbers (
          id String,
          workspace_id String,
          e164 String,
          source Enum8('seo' = 1, 'ads' = 2, 'direct' = 3, 'email' = 4, 'social' = 5, 'print' = 6, 'other' = 7) DEFAULT 'direct',
          label String DEFAULT '',
          created_at DateTime64(3) DEFAULT now64(3),
          updated_at DateTime64(3) DEFAULT now64(3),
          deleted_at Nullable(DateTime64(3))
        ) ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY (workspace_id, e164)
      `,
    });

    console.log('[V8 Migration] VoIP tables created');
  },

  async migrateWorkspace(): Promise<void> {
    // No workspace-level changes
  },
};
