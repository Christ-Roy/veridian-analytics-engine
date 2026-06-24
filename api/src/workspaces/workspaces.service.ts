import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClickHouseService } from '../database/clickhouse.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import {
  Workspace,
  WorkspaceSettings,
  DEFAULT_WORKSPACE_SETTINGS,
  deriveAllowedDomains,
} from './entities/workspace.entity';
import { Integration } from './entities/integration.entity';
import { encryptApiKey, generateId } from '../common/crypto';
import {
  toClickHouseDateTime,
  parseClickHouseDateTime,
} from '../common/utils/datetime.util';
import { getDefaultFilters } from './fixtures/default-filters';
import { BackfillTask } from '../filters/backfill/backfill-task.entity';

interface CurrentUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
}

interface WorkspaceRow extends Omit<Workspace, 'settings'> {
  settings: string; // JSON string from ClickHouse
}

/**
 * Return a ClickHouse DateTime64(3) string exactly 1ms after the given one.
 * Used to guarantee a strictly-increasing `updated_at` when two updates land
 * within the same millisecond, so the ReplacingMergeTree(updated_at) never
 * ties and keeps the newer version.
 */
function bumpMillis(datetime: string): string {
  const next = new Date(parseClickHouseDateTime(datetime).getTime() + 1);
  return toClickHouseDateTime(next);
}

function parseWorkspace(row: WorkspaceRow): Workspace {
  const settings = row.settings
    ? (JSON.parse(row.settings) as Partial<WorkspaceSettings>)
    : {};

  return {
    id: row.id,
    name: row.name,
    website: row.website,
    timezone: row.timezone,
    currency: row.currency,
    logo_url: row.logo_url,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    settings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      ...settings,
    },
  };
}

function serializeWorkspace(
  workspace: Workspace,
): Omit<Workspace, 'settings'> & { settings: string } {
  return {
    id: workspace.id,
    name: workspace.name,
    website: workspace.website,
    timezone: workspace.timezone,
    currency: workspace.currency,
    logo_url: workspace.logo_url,
    status: workspace.status,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
    settings: JSON.stringify(workspace.settings),
  };
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async list(user: CurrentUser): Promise<Workspace[]> {
    // Super admins see all workspaces.
    // The inner `ORDER BY updated_at DESC … LIMIT 1 BY id` collapses any
    // transient duplicate rows the ReplacingMergeTree may still hold before its
    // background merge — we always surface the freshest version per workspace.
    if (user.isSuperAdmin) {
      const rows = await this.clickhouse.querySystem<WorkspaceRow>(
        `SELECT * FROM (
           SELECT * FROM workspaces
           ORDER BY updated_at DESC
           LIMIT 1 BY id
         )
         ORDER BY created_at DESC`,
      );
      return rows.map(parseWorkspace);
    }

    // Regular users only see workspaces they are members of.
    const rows = await this.clickhouse.querySystem<WorkspaceRow>(
      `SELECT * FROM (
         SELECT * FROM workspaces
         WHERE id IN (
           SELECT workspace_id FROM workspace_memberships FINAL
           WHERE user_id = {userId:String}
         )
         ORDER BY updated_at DESC
         LIMIT 1 BY id
       )
       ORDER BY created_at DESC`,
      { userId: user.id },
    );
    return rows.map(parseWorkspace);
  }

  async get(id: string): Promise<Workspace> {
    // Use ORDER BY updated_at DESC LIMIT 1 to handle ClickHouse async DELETE race condition
    // During mutations, there may be duplicate rows temporarily
    const rows = await this.clickhouse.querySystem<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE id = {id:String} ORDER BY updated_at DESC LIMIT 1',
      { id },
    );
    if (rows.length === 0) {
      throw new NotFoundException(`Workspace ${id} not found`);
    }
    return parseWorkspace(rows[0]);
  }

  async create(dto: CreateWorkspaceDto, user: CurrentUser): Promise<Workspace> {
    // Only super admins can create workspaces
    if (!user.isSuperAdmin) {
      throw new ForbiddenException(
        'Only super admins can create new workspaces',
      );
    }

    const now = toClickHouseDateTime();

    // Build settings from dto.settings with defaults
    const settings: WorkspaceSettings = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      ...(dto.settings || {}),
    };

    // Apply default filters if none provided
    if (!settings.filters || settings.filters.length === 0) {
      settings.filters = getDefaultFilters();
    }

    // Seed allowed_domains from the client's own website so a fresh workspace
    // is NOT open to tracking from any spoofed Origin by default
    // (ticket 2026-06-23-ingest-allowed-domains-vide). Only when the caller
    // didn't provide an explicit list — an explicit [] stays "allow all".
    if (settings.allowed_domains === undefined) {
      const derived = deriveAllowedDomains(dto.website);
      if (derived.length > 0) {
        settings.allowed_domains = derived;
      }
    }

    const workspace: Workspace = {
      id: dto.id,
      name: dto.name,
      website: dto.website,
      timezone: dto.timezone,
      currency: dto.currency,
      logo_url: dto.logo_url,
      status: 'initializing',
      created_at: now,
      updated_at: now,
      settings,
    };

    // 1. Create workspace database first
    // If this fails, we don't insert the workspace row (returns 500)
    await this.clickhouse.createWorkspaceDatabase(dto.id);

    // 2. Insert workspace row into system database
    await this.clickhouse.insertSystem('workspaces', [
      serializeWorkspace(workspace),
    ]);

    // 3. Add creator as owner to workspace_memberships
    await this.clickhouse.insertSystem('workspace_memberships', [
      {
        id: generateId(),
        workspace_id: dto.id,
        user_id: user.id,
        role: 'owner',
        invited_by: null,
        joined_at: now,
        created_at: now,
        updated_at: now,
      },
    ]);

    // 4. Create completed backfill task to mark default filters as synced
    // This prevents the "Filters out of sync" warning in the UI
    if (settings.filters && settings.filters.length > 0) {
      const backfillTask: BackfillTask = {
        id: generateId(),
        workspace_id: dto.id,
        status: 'completed',
        lookback_days: 0,
        chunk_size_days: 1,
        batch_size: 1000,
        total_sessions: 0,
        processed_sessions: 0,
        total_events: 0,
        processed_events: 0,
        current_date_chunk: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: now,
        error_message: null,
        retry_count: 0,
        filters_snapshot: JSON.stringify(settings.filters),
      };
      await this.clickhouse.insertSystem('backfill_tasks', [backfillTask]);
    }

    // Status remains 'initializing' until first event is received
    return workspace;
  }

  async update(dto: UpdateWorkspaceDto): Promise<Workspace> {
    const workspace = await this.get(dto.id);

    // Merge settings if provided
    let updatedSettings = workspace.settings;
    if (dto.settings) {
      // Encrypt API keys in integrations if provided
      if (dto.settings.integrations) {
        dto.settings.integrations = this.encryptIntegrationKeys(
          dto.settings.integrations,
          dto.id,
        );
      }

      // Filter out undefined values from dto.settings to prevent overwriting
      // existing values. class-transformer adds undefined for all optional DTO fields.
      const definedSettings = Object.fromEntries(
        Object.entries(dto.settings).filter(([, v]) => v !== undefined),
      ) as Partial<WorkspaceSettings>;

      updatedSettings = {
        ...workspace.settings,
        ...definedSettings,
      };
    }

    // Strictly-increasing updated_at so the ReplacingMergeTree (keyed on
    // updated_at) always picks THIS version over the row we just read. Two
    // updates within the same millisecond would otherwise tie on updated_at and
    // the engine could keep the older row → silent data loss. We clamp the new
    // timestamp to be > the row we merged from.
    const now = toClickHouseDateTime();
    const nextUpdatedAt = now > workspace.updated_at ? now : bumpMillis(workspace.updated_at);

    const updated: Workspace = {
      id: workspace.id,
      name: dto.name ?? workspace.name,
      website: dto.website ?? workspace.website,
      timezone: dto.timezone ?? workspace.timezone,
      currency: dto.currency ?? workspace.currency,
      logo_url: dto.logo_url ?? workspace.logo_url,
      status: dto.status ?? workspace.status,
      created_at: workspace.created_at,
      updated_at: nextUpdatedAt,
      settings: updatedSettings,
    };

    // INSERT-only update (no async DELETE). The `workspaces` table is a
    // ReplacingMergeTree(updated_at): inserting a new row with a newer
    // updated_at supersedes the previous version. Reads dedup on the freshest
    // row — `ORDER BY updated_at DESC LIMIT 1` (get) and `ORDER BY updated_at
    // DESC … LIMIT 1 BY id` (list) — so the fresh version is visible
    // IMMEDIATELY: no waiting for an async mutation, no transient window where
    // the row reads empty. This kills the DELETE-then-INSERT race that silently
    // dropped settings on rapid, back-to-back updates (e.g. setFeatures
    // off-then-on losing the off flags).
    await this.clickhouse.insertSystem('workspaces', [
      serializeWorkspace(updated),
    ]);

    // Emit event to invalidate caches when settings change
    if (dto.settings) {
      this.eventEmitter.emit('workspace.settings.changed', {
        workspaceId: dto.id,
      });
    }

    return updated;
  }

  /**
   * Flip a workspace out of the 'initializing' bootstrap state into 'active'
   * once it has received its first valid event (called best-effort by the
   * SessionPayloadHandler). This is the transition the create() comment
   * ("Status remains initializing until first event is received") always
   * promised but never implemented — its
   * absence, combined with the ingestion kill-switch, silently dropped 100 % of
   * a freshly-provisioned client's traffic (P0 2026-06-24, incident Yoga Sculpt).
   *
   * Idempotent & race-safe by construction:
   *   - Re-reads the freshest row; only flips when status is STILL 'initializing'
   *     (a concurrent flip, a manual activation, or an admin suspension all make
   *     this a no-op → returns false, never clobbers a deliberate state).
   *   - Uses the SAME INSERT-only ReplacingMergeTree(updated_at) path as
   *     update(), with the strictly-increasing updated_at guard, so it can never
   *     resurrect a stale version or race the async-DELETE the legacy update had.
   *   - Preserves settings verbatim (re-serialises the row we just read) — no
   *     field is touched except status + updated_at.
   *
   * @returns true if it actually transitioned, false if it was already past
   *          'initializing' (or vanished) and nothing was written.
   */
  async activateIfInitializing(id: string): Promise<boolean> {
    let workspace: Workspace;
    try {
      workspace = await this.get(id);
    } catch {
      // Workspace deleted between ingestion and this best-effort flip — no-op.
      return false;
    }

    if (workspace.status !== 'initializing') {
      return false;
    }

    const now = toClickHouseDateTime();
    const nextUpdatedAt =
      now > workspace.updated_at ? now : bumpMillis(workspace.updated_at);

    const activated: Workspace = {
      ...workspace,
      status: 'active',
      updated_at: nextUpdatedAt,
    };

    await this.clickhouse.insertSystem('workspaces', [
      serializeWorkspace(activated),
    ]);

    // Invalidate every workspace cache (handler + analytics) so the fresh
    // 'active' status is read immediately, not after the 60s TTL.
    this.eventEmitter.emit('workspace.settings.changed', { workspaceId: id });

    return true;
  }

  /**
   * Encrypt API keys in integrations that are not already encrypted.
   * Encrypted keys contain ':' separators (format: iv:authTag:data).
   */
  private encryptIntegrationKeys(
    integrations: Integration[],
    workspaceId: string,
  ): Integration[] {
    const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY')!;

    return integrations.map((integration) => {
      if (integration.type === 'anthropic') {
        const anthropic = integration;
        const apiKey = anthropic.settings.api_key_encrypted;
        // Only encrypt if it's a new key (not already encrypted)
        // Encrypted format is iv:authTag:data, so it contains ':'
        if (apiKey && !apiKey.includes(':')) {
          anthropic.settings.api_key_encrypted = encryptApiKey(
            apiKey,
            encryptionKey,
            workspaceId,
          );
        }
      }
      return integration;
    });
  }

  async delete(id: string): Promise<void> {
    // Verify workspace exists
    const rows = await this.clickhouse.querySystem<Workspace>(
      'SELECT id FROM workspaces WHERE id = {id:String}',
      { id },
    );
    if (rows.length === 0) {
      throw new NotFoundException(`Workspace ${id} not found`);
    }

    // All DELETEs below are parameterized ({id:String}) — never interpolate the
    // workspace id into raw SQL, even though it is validated upstream. Defense
    // in depth against SQL injection on the ClickHouse system DB.

    // 1. Delete workspace memberships
    await this.clickhouse.commandSystemWithParams(
      `ALTER TABLE workspace_memberships DELETE WHERE workspace_id = {id:String}`,
      { id },
    );

    // 2. Delete invitations
    await this.clickhouse.commandSystemWithParams(
      `ALTER TABLE invitations DELETE WHERE workspace_id = {id:String}`,
      { id },
    );

    // 3. Delete workspace-scoped API keys
    await this.clickhouse.commandSystemWithParams(
      `ALTER TABLE api_keys DELETE WHERE workspace_id = {id:String}`,
      { id },
    );

    // 4. Delete backfill tasks
    await this.clickhouse.commandSystemWithParams(
      `ALTER TABLE backfill_tasks DELETE WHERE workspace_id = {id:String}`,
      { id },
    );

    // 5. Drop workspace database (cascades to all tables)
    await this.clickhouse.dropWorkspaceDatabase(id);

    // 6. Delete workspace row from system database
    await this.clickhouse.commandSystemWithParams(
      `ALTER TABLE workspaces DELETE WHERE id = {id:String}`,
      { id },
    );
  }
}
