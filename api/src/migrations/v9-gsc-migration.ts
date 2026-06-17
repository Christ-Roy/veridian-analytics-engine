import { ClickHouseClient } from '@clickhouse/client';
import { MajorMigration } from './migration.interface';

/**
 * V9 GSC Migration
 *
 * Crée les tables `gsc_property` et `gsc_daily` dans la system database pour le
 * module Search Console natif (port du bridge Express vers l'engine).
 *
 * - `gsc_property` : 1 row / workspace, la liaison OAuth (tokens chiffrés
 *   AES-256-GCM clé-par-workspace) + l'état de la propriété GSC résolue.
 *   ReplacingMergeTree(updated_at) → upserts (refresh token, mark synced,
 *   soft-delete) en ré-insérant avec le même ORDER BY.
 * - `gsc_daily` : données agrégées GSC par
 *   (property, date, query, page, country, device, search_type).
 *   ReplacingMergeTree(updated_at) pour l'idempotence du sync (re-sync d'une
 *   fenêtre = ré-insertion, pas de doublon après FINAL). Pas de PRIMARY KEY /
 *   UNIQUE (ClickHouse) — l'unicité logique est portée par l'ORDER BY.
 *
 * Choix de stockage : system DB ClickHouse (PAS Postgres) — l'engine n'a pas
 * de Postgres applicatif ; toute la donnée vit dans ClickHouse (cf
 * webhooks/api-keys). C'est de la donnée analytique relationnelle, pas des
 * events de tracking → system DB et non DB workspace.
 *
 * Les fresh installs obtiennent ces tables via SYSTEM_SCHEMAS
 * (`database/schemas.ts`, initSystemDatabase). Cette migration couvre le
 * chemin d'upgrade des installs existantes en version majeure 8.
 */
export const V9GscMigration: MajorMigration = {
  majorVersion: 9,

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
    console.log('[V9 Migration] Creating gsc_property table...');
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.gsc_property (
          id String,
          workspace_id String,
          site_url String DEFAULT '',
          ownership_state Enum8('pending' = 0, 'verified' = 1) DEFAULT 'pending',
          oauth_tokens_encrypted String DEFAULT '',
          last_sync_at Nullable(DateTime64(3)),
          created_at DateTime64(3) DEFAULT now64(3),
          updated_at DateTime64(3) DEFAULT now64(3),
          deleted_at Nullable(DateTime64(3))
        ) ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY (workspace_id, id)
      `,
    });

    console.log('[V9 Migration] Creating gsc_daily table...');
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.gsc_daily (
          gsc_property_id String,
          workspace_id String,
          date Date,
          query String,
          page String,
          country String DEFAULT '',
          device String DEFAULT '',
          search_type Enum8('web' = 0, 'image' = 1, 'video' = 2, 'news' = 3, 'discover' = 4, 'googleNews' = 5) DEFAULT 'web',
          impressions UInt64 DEFAULT 0,
          clicks UInt64 DEFAULT 0,
          position Float64 DEFAULT 0,
          ctr Float64 DEFAULT 0,
          updated_at DateTime64(3) DEFAULT now64(3)
        ) ENGINE = ReplacingMergeTree(updated_at)
        PARTITION BY toYYYYMM(date)
        ORDER BY (gsc_property_id, search_type, date, query, page, country, device)
      `,
    });

    console.log('[V9 Migration] gsc tables created');
  },

  async migrateWorkspace(): Promise<void> {
    // No workspace-level changes
  },
};
