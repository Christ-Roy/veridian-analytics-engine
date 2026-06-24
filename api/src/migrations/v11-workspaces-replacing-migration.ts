import { ClickHouseClient } from '@clickhouse/client';
import { MajorMigration } from './migration.interface';

/**
 * V11 Workspaces ReplacingMergeTree Migration (silent data-loss fix —
 * ticket 2026-06-24-setfeatures-replace-au-lieu-de-deep-merge).
 *
 * The `workspaces` system table was created as a plain `MergeTree`. Because a
 * plain MergeTree never deduplicates rows, `WorkspacesService.update()` had to
 * emulate an UPDATE with a **non-atomic DELETE-then-INSERT**:
 *
 *     ALTER TABLE workspaces DELETE WHERE id = '…'   -- async mutation
 *     INSERT INTO workspaces …                        -- new version
 *
 * ClickHouse `ALTER … DELETE` is an asynchronous mutation. On rapid,
 * back-to-back updates (e.g. `setFeatures` flipping flags off then on a few
 * hundred ms apart), the in-flight DELETE of update #1 could make update #2's
 * read (`get()` → `SELECT … ORDER BY updated_at DESC LIMIT 1`) return an EMPTY
 * or stale state. The deep-merge in `setFeatures` then started from `{}` and
 * silently overwrote the other flags — confirmed in real staging.
 *
 * Fix: convert `workspaces` to `ReplacingMergeTree(updated_at)`, like its
 * sibling system tables (`users`, `workspace_memberships`, `sessions`,
 * `backfill_tasks`). Updates become a single INSERT with a newer `updated_at`;
 * the engine supersedes the old version and reads (`ORDER BY updated_at DESC
 * LIMIT 1` / `LIMIT 1 BY id`) see the fresh row IMMEDIATELY — no async DELETE,
 * no race, no data loss.
 *
 * This migration rebuilds the table in place and is non-destructive: it copies
 * every workspace, keeping the freshest version per id (dedup), then atomically
 * swaps the new table for the old one via `EXCHANGE TABLES`.
 *
 * System-level only (the `workspaces` table lives in the system database).
 * Fresh installs already get `ReplacingMergeTree` via SYSTEM_SCHEMAS
 * (`database/schemas.ts`); this covers installs already on major version 10.
 */
export const V11WorkspacesReplacingMigration: MajorMigration = {
  majorVersion: 11,

  hasSystemMigration(): boolean {
    return true;
  },

  hasWorkspaceMigration(): boolean {
    return false;
  },

  async migrateSystem(client: ClickHouseClient, systemDb: string): Promise<void> {
    console.log(
      `[V11 Migration] Converting ${systemDb}.workspaces MergeTree → ReplacingMergeTree(updated_at)...`,
    );

    // 1. Build the replacement table with the target engine. Same column
    //    layout as SYSTEM_SCHEMAS.workspaces. IF NOT EXISTS → idempotent.
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.workspaces_v11 (
          id String,
          name String,
          website String,
          timezone String,
          currency String,
          logo_url Nullable(String),
          settings String DEFAULT '{}',
          status Enum8('initializing' = 1, 'active' = 2, 'inactive' = 3, 'error' = 4),
          created_at DateTime64(3) DEFAULT now64(3),
          updated_at DateTime64(3) DEFAULT now64(3)
        ) ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY id
      `,
    });

    // 2. Make sure a re-run starts from an empty replacement table (in case a
    //    previous attempt failed after CREATE but before EXCHANGE).
    await client.command({
      query: `TRUNCATE TABLE IF EXISTS ${systemDb}.workspaces_v11`,
    });

    // 3. Copy the freshest version of every workspace (dedup on id, keeping the
    //    max updated_at). Equivalent to what `list()`/`get()` already do.
    await client.command({
      query: `
        INSERT INTO ${systemDb}.workspaces_v11
        SELECT id, name, website, timezone, currency, logo_url, settings,
               status, created_at, updated_at
        FROM (
          SELECT * FROM ${systemDb}.workspaces
          ORDER BY updated_at DESC
          LIMIT 1 BY id
        )
      `,
    });

    // 4. Atomically swap the new table for the old one. EXCHANGE TABLES is
    //    supported on the Atomic database engine (ClickHouse ≥ 21.x) and is a
    //    single metadata operation — no window where `workspaces` is missing.
    await client.command({
      query: `EXCHANGE TABLES ${systemDb}.workspaces AND ${systemDb}.workspaces_v11`,
    });

    // 5. Drop the now-old (originally MergeTree) table, currently named
    //    workspaces_v11 after the swap.
    await client.command({
      query: `DROP TABLE IF EXISTS ${systemDb}.workspaces_v11`,
    });

    console.log(
      `[V11 Migration] ${systemDb}.workspaces is now ReplacingMergeTree(updated_at).`,
    );
  },

  async migrateWorkspace(): Promise<void> {
    // No workspace-level changes.
  },
};
