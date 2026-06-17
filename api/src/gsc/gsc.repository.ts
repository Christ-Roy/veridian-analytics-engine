import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../database/clickhouse.service';
import { generateId } from '../common/crypto';
import { toClickHouseDateTime } from '../common/utils/datetime.util';
import {
  GscDailyRow,
  GscSearchType,
} from './entities/gsc-daily.entity';
import {
  GscOwnershipState,
  GscProperty,
} from './entities/gsc-property.entity';

interface PropertyRow {
  id: string;
  workspace_id: string;
  site_url: string;
  ownership_state: string;
  oauth_tokens_encrypted: string;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface DailyDbRow {
  gsc_property_id: string;
  workspace_id: string;
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  search_type: string;
  impressions: number | string;
  clicks: number | string;
  position: number;
  ctr: number;
}

const PROPERTY_TABLE = 'gsc_property';
const DAILY_TABLE = 'gsc_daily';

/**
 * Couche d'accès ClickHouse (system DB) du module GSC.
 *
 * `gsc_property` et `gsc_daily` sont des ReplacingMergeTree : on "update" en
 * ré-insérant la row avec le même ORDER BY + un `updated_at` plus récent, et on
 * lit toujours avec `FINAL` (même pattern que webhooks/api-keys). Le repository
 * isole le SQL ; les services (oauth / sync / query) ne touchent jamais
 * directement à ClickHouse.
 */
@Injectable()
export class GscRepository {
  constructor(private readonly clickhouse: ClickHouseService) {}

  // ─── Property ─────────────────────────────────────────────────────────

  /** Property active (non soft-deleted) d'un workspace, ou null. */
  async findPropertyByWorkspace(
    workspaceId: string,
  ): Promise<GscProperty | null> {
    const rows = await this.clickhouse.querySystem<PropertyRow>(
      `SELECT * FROM ${PROPERTY_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
      { workspace_id: workspaceId },
    );
    return rows.length > 0 ? this.parseProperty(rows[0]) : null;
  }

  /** Toutes les properties `verified` non supprimées (cible du cron de sync). */
  async findVerifiedProperties(): Promise<GscProperty[]> {
    const rows = await this.clickhouse.querySystem<PropertyRow>(
      `SELECT * FROM ${PROPERTY_TABLE} FINAL
       WHERE ownership_state = 'verified'
         AND deleted_at IS NULL`,
    );
    return rows.map((r) => this.parseProperty(r));
  }

  /**
   * Upsert une property. Si le workspace a déjà une property active on garde
   * son `id` + `created_at` (un seul GSC par workspace), sinon on en crée une.
   */
  async upsertProperty(input: {
    workspaceId: string;
    siteUrl: string;
    ownershipState: GscOwnershipState;
    oauthTokensEncrypted: string;
    lastSyncAt?: string | null;
  }): Promise<GscProperty> {
    const existing = await this.findPropertyByWorkspace(input.workspaceId);
    const now = toClickHouseDateTime();
    const prop: GscProperty = {
      id: existing?.id ?? `gsc_${generateId().replace(/-/g, '').slice(0, 22)}`,
      workspace_id: input.workspaceId,
      site_url: input.siteUrl,
      ownership_state: input.ownershipState,
      oauth_tokens_encrypted: input.oauthTokensEncrypted,
      last_sync_at:
        input.lastSyncAt !== undefined
          ? input.lastSyncAt
          : (existing?.last_sync_at ?? null),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      deleted_at: null,
    };
    await this.clickhouse.insertSystem(PROPERTY_TABLE, [
      this.serializeProperty(prop),
    ]);
    return prop;
  }

  /** Met à jour le blob de tokens (après refresh) sans toucher au reste. */
  async updateTokens(
    prop: GscProperty,
    oauthTokensEncrypted: string,
  ): Promise<void> {
    const updated: GscProperty = {
      ...prop,
      oauth_tokens_encrypted: oauthTokensEncrypted,
      updated_at: toClickHouseDateTime(),
    };
    await this.clickhouse.insertSystem(PROPERTY_TABLE, [
      this.serializeProperty(updated),
    ]);
  }

  async markSynced(prop: GscProperty): Promise<void> {
    const updated: GscProperty = {
      ...prop,
      last_sync_at: toClickHouseDateTime(),
      updated_at: toClickHouseDateTime(),
    };
    await this.clickhouse.insertSystem(PROPERTY_TABLE, [
      this.serializeProperty(updated),
    ]);
  }

  /** Soft-delete + purge du token chiffré (déconnexion GSC). */
  async softDelete(prop: GscProperty): Promise<void> {
    const now = toClickHouseDateTime();
    const tombstoned: GscProperty = {
      ...prop,
      ownership_state: 'pending',
      oauth_tokens_encrypted: '',
      deleted_at: now,
      updated_at: now,
    };
    await this.clickhouse.insertSystem(PROPERTY_TABLE, [
      this.serializeProperty(tombstoned),
    ]);
  }

  // ─── Daily rows ───────────────────────────────────────────────────────

  /**
   * Remplace les rows d'une fenêtre [start, end] pour une property + search_type
   * puis insère les nouvelles. Idempotent : un re-sync de la même fenêtre ne
   * crée pas de doublon (ReplacingMergeTree + même ORDER BY).
   */
  async replaceDailyWindow(
    gscPropertyId: string,
    searchType: GscSearchType,
    startDate: string,
    endDate: string,
    rows: GscDailyRow[],
  ): Promise<number> {
    await this.clickhouse.commandSystemWithParams(
      `ALTER TABLE ${DAILY_TABLE} DELETE
       WHERE gsc_property_id = {gsc_property_id:String}
         AND search_type = {search_type:String}
         AND date >= {start:String}
         AND date <= {end:String}`,
      {
        gsc_property_id: gscPropertyId,
        search_type: searchType,
        start: startDate,
        end: endDate,
      },
    );
    if (rows.length === 0) return 0;
    const BATCH = 1000;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH).map((r) => ({
        gsc_property_id: r.gsc_property_id,
        workspace_id: r.workspace_id,
        date: r.date,
        query: r.query,
        page: r.page,
        country: r.country,
        device: r.device,
        search_type: r.search_type,
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position,
        ctr: r.ctr,
      }));
      await this.clickhouse.insertSystem(DAILY_TABLE, chunk);
      inserted += chunk.length;
    }
    return inserted;
  }

  // ─── Sérialisation ────────────────────────────────────────────────────

  private serializeProperty(p: GscProperty): Record<string, unknown> {
    return {
      id: p.id,
      workspace_id: p.workspace_id,
      site_url: p.site_url,
      ownership_state: p.ownership_state,
      oauth_tokens_encrypted: p.oauth_tokens_encrypted,
      last_sync_at: p.last_sync_at,
      created_at: p.created_at,
      updated_at: p.updated_at,
      deleted_at: p.deleted_at,
    };
  }

  private parseProperty(row: PropertyRow): GscProperty {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      site_url: row.site_url,
      ownership_state: row.ownership_state as GscOwnershipState,
      oauth_tokens_encrypted: row.oauth_tokens_encrypted ?? '',
      last_sync_at: row.last_sync_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  }
}
