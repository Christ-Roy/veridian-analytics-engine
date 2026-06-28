import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClickHouseService } from '../../database/clickhouse.service';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import { TrackingEvent } from '../../events/entities/event.entity';
import { BackfillTask } from '../../filters/backfill/backfill-task.entity';
import { toClickHouseDateTime } from '../../common/utils/datetime.util';
import {
  DEMO_SESSION_PREFIX,
  generateDemoEvents,
} from './demo-tenant.generator';

/** The 4 tables a demo seed writes into, with the column carrying session_id. */
const DEMO_TABLES: Array<{ table: 'events' | 'sessions' | 'pages' | 'goals'; col: string }> = [
  { table: 'events', col: 'session_id' },
  { table: 'sessions', col: 'id' }, // sessions_mv sets id = session_id
  { table: 'pages', col: 'session_id' },
  { table: 'goals', col: 'session_id' },
];

const INSERT_BATCH = 10_000;

/** Per-table row counts (the 4 demo tables). */
export interface RowCounts {
  events: number;
  sessions: number;
  pages: number;
  goals: number;
}

export interface DemoSeedResult {
  workspace_id: string;
  is_demo: true;
  run_id: string;
  seeded: {
    events: number;
    web_sessions: number;
    voip_calls: number;
  };
  /** Rows now tagged demo, per table (post-seed, mutations settled). */
  mock_rows: RowCounts;
  /** Real (non-demo) rows, untouched. */
  real_rows: RowCounts;
  date_range: { start: string; end: string };
}

export interface DemoWipeResult {
  workspace_id: string;
  is_demo: false;
  /** Demo rows removed, per table (count BEFORE the wipe). */
  deleted: RowCounts;
  /**
   * Real (non-demo) rows — counted BEFORE and AFTER the wipe. They MUST be
   * identical; a discrepancy means the wipe touched real data (it never
   * should — it filters strictly on the `vrddemo_` prefix).
   */
  preserved_real: {
    before: RowCounts;
    after: RowCounts;
    intact: boolean;
  };
  /** True when there was no demo data to remove (clean no-op). */
  noop: boolean;
}

export interface DemoStatusResult {
  workspace_id: string;
  exists: true;
  is_demo: boolean;
  mock_rows: RowCounts;
  real_rows: RowCounts;
}

/**
 * Demo-mode for an EXISTING tenant (M2M).
 *
 * Seeds synthetic-but-realistic staminads data INTO a real workspace so a
 * prospect sees the product alive, then wipes it surgically by the
 * `vrddemo_` session_id prefix — leaving the client's real data untouched.
 *
 * This is intentionally separate from `DemoService` (the public `demo-apple`
 * instance), which creates/drops a whole workspace database. Here we never
 * create or drop a database; we only inject/remove rows in the tenant's own
 * tables. The legacy public-demo path is NOT touched.
 */
@Injectable()
export class DemoTenantService {
  private readonly logger = new Logger(DemoTenantService.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  /**
   * Seed demo data into an existing workspace.
   *
   * Guard: if the workspace already holds REAL (non-demo) events, refuse with
   * 409 DEMO_REAL_DATA_PRESENT unless `force` is true — we never want to bury a
   * client's real traffic under demo noise by accident.
   */
  async seed(opts: {
    workspaceId: string;
    sessionCount?: number;
    voipCount?: number;
    daysRange?: number;
    force?: boolean;
  }): Promise<DemoSeedResult> {
    const workspace = await this.requireWorkspace(opts.workspaceId);

    // Guard — refuse to seed over real data unless forced.
    if (!opts.force) {
      const realEvents = await this.countRealEvents(opts.workspaceId);
      if (realEvents > 0) {
        throw new ConflictException({
          code: 'DEMO_REAL_DATA_PRESENT',
          message:
            `Workspace ${opts.workspaceId} already has ${realEvents} real (non-demo) event(s). ` +
            'Refusing to seed demo data over real traffic. Pass force:true to override.',
        });
      }
    }

    const sessionCount = clamp(opts.sessionCount ?? 4000, 1, 50_000);
    const voipCount = clamp(opts.voipCount ?? 40, 0, 5_000);
    const daysRange = clamp(opts.daysRange ?? 30, 1, 365);
    const runId = randomUUID().slice(0, 8);
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - daysRange * 86_400_000);

    const { events } = generateDemoEvents({
      workspaceId: opts.workspaceId,
      website: workspace.website,
      endDate,
      daysRange,
      sessionCount,
      voipCount,
      runId,
    });

    await this.insertEventsBatched(opts.workspaceId, events);
    await this.createSyntheticBackfillTask(opts.workspaceId, sessionCount, events.length);

    // Flip is_demo=true (JSON settings, no migration).
    await this.setDemoFlag(opts.workspaceId, true);

    // Let the materialized views settle so the status counts are truthful.
    await this.waitForSessionsMaterialized(opts.workspaceId, runId, sessionCount);

    const mock_rows = await this.countDemoRows(opts.workspaceId);
    const real_rows = await this.countRealRows(opts.workspaceId);

    this.logger.log(
      `[demo] seeded ws=${opts.workspaceId} run=${runId} ` +
        `events=${events.length} sessions=${sessionCount} voip=${voipCount}`,
    );

    return {
      workspace_id: opts.workspaceId,
      is_demo: true,
      run_id: runId,
      seeded: {
        events: events.length,
        web_sessions: sessionCount,
        voip_calls: voipCount,
      },
      mock_rows,
      real_rows,
      date_range: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      },
    };
  }

  /**
   * Wipe ALL demo data (every stacked seed) from a workspace by the
   * `vrddemo_` session_id prefix. Counts the real (non-demo) rows BEFORE and
   * AFTER so the caller has an auditable proof the real data was untouched.
   * A wipe on 0 demo rows is a clean no-op (no error).
   */
  async wipe(workspaceId: string): Promise<DemoWipeResult> {
    await this.requireWorkspace(workspaceId);

    const deleted = await this.countDemoRows(workspaceId);
    const realBefore = await this.countRealRows(workspaceId);
    const noop = totalRows(deleted) === 0;

    if (!noop) {
      for (const t of DEMO_TABLES) {
        // Synchronous mutation (mutations_sync=2) so the counts after are real,
        // not eventually-consistent. startsWith(prefix) hits the ORDER BY key on
        // every table → cheap. Parameterized → injection-safe.
        await this.clickhouse.commandWorkspaceWithParams(
          workspaceId,
          `ALTER TABLE ${t.table} DELETE WHERE startsWith(${t.col}, {prefix:String}) SETTINGS mutations_sync=2`,
          { prefix: DEMO_SESSION_PREFIX },
        );
      }
      // Drop the synthetic backfill task(s) we created for the demo seeds.
      await this.clickhouse.commandSystemWithParams(
        `ALTER TABLE backfill_tasks DELETE WHERE workspace_id = {ws:String} AND error_message = {tag:String}`,
        { ws: workspaceId, tag: DEMO_BACKFILL_TAG },
      );
    }

    // is_demo=false regardless (idempotent — clearing the flag is always safe).
    await this.setDemoFlag(workspaceId, false);

    const realAfter = await this.countRealRows(workspaceId);
    const intact = sameCounts(realBefore, realAfter);
    if (!intact) {
      // This must never happen — the prefix filter cannot match a real row.
      // Surfacing it loudly beats silently lying that the data is safe.
      this.logger.error(
        `[demo] WIPE INTEGRITY BREACH ws=${workspaceId} ` +
          `real before=${JSON.stringify(realBefore)} after=${JSON.stringify(realAfter)}`,
      );
    }

    this.logger.log(
      `[demo] wiped ws=${workspaceId} deleted=${JSON.stringify(deleted)} ` +
        `real_intact=${intact} noop=${noop}`,
    );

    return {
      workspace_id: workspaceId,
      is_demo: false,
      deleted,
      preserved_real: { before: realBefore, after: realAfter, intact },
      noop,
    };
  }

  /** Read the demo state of a workspace (mock vs real row counts + flag). */
  async status(workspaceId: string): Promise<DemoStatusResult> {
    const workspace = await this.requireWorkspace(workspaceId);
    const mock_rows = await this.countDemoRows(workspaceId);
    const real_rows = await this.countRealRows(workspaceId);
    return {
      workspace_id: workspaceId,
      exists: true,
      is_demo: workspace.settings.is_demo === true,
      mock_rows,
      real_rows,
    };
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private async requireWorkspace(workspaceId: string) {
    try {
      return await this.workspacesService.get(workspaceId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new NotFoundException({
          code: 'workspace_not_found',
          message: `Workspace ${workspaceId} not found`,
        });
      }
      throw err;
    }
  }

  private async setDemoFlag(workspaceId: string, value: boolean): Promise<void> {
    await this.workspacesService.update({
      id: workspaceId,
      settings: { is_demo: value },
    });
  }

  private async insertEventsBatched(
    workspaceId: string,
    events: TrackingEvent[],
  ): Promise<void> {
    for (let i = 0; i < events.length; i += INSERT_BATCH) {
      await this.clickhouse.insertWorkspace(
        workspaceId,
        'events',
        events.slice(i, i + INSERT_BATCH),
      );
    }
  }

  /** Count REAL events only (events table is the source of truth for ingestion). */
  private async countRealEvents(workspaceId: string): Promise<number> {
    const rows = await this.clickhouse.queryWorkspace<{ c: string }>(
      workspaceId,
      `SELECT count() AS c FROM events WHERE NOT startsWith(session_id, {prefix:String})`,
      { prefix: DEMO_SESSION_PREFIX },
    );
    return Number(rows[0]?.c ?? 0);
  }

  /** Demo (vrddemo_-prefixed) row counts across the 4 tables. */
  private async countDemoRows(workspaceId: string): Promise<RowCounts> {
    return this.countRows(workspaceId, true);
  }

  /** Real (NOT vrddemo_-prefixed) row counts across the 4 tables. */
  private async countRealRows(workspaceId: string): Promise<RowCounts> {
    return this.countRows(workspaceId, false);
  }

  private async countRows(
    workspaceId: string,
    demo: boolean,
  ): Promise<RowCounts> {
    const out: RowCounts = { events: 0, sessions: 0, pages: 0, goals: 0 };
    for (const t of DEMO_TABLES) {
      const predicate = demo
        ? `startsWith(${t.col}, {prefix:String})`
        : `NOT startsWith(${t.col}, {prefix:String})`;
      // FINAL collapses ReplacingMergeTree duplicates so counts are exact even
      // mid-merge — the row volumes here are small (per-workspace demo data).
      const rows = await this.clickhouse.queryWorkspace<{ c: string }>(
        workspaceId,
        `SELECT count() AS c FROM ${t.table} FINAL WHERE ${predicate}`,
        { prefix: DEMO_SESSION_PREFIX },
      );
      out[t.table] = Number(rows[0]?.c ?? 0);
    }
    return out;
  }

  /**
   * Poll until the demo sessions are materialized (sessions_mv has fired) so
   * status counts are truthful right after seed. Bounded + fail-soft — a
   * timeout only means the MV is still settling, never throws.
   */
  private async waitForSessionsMaterialized(
    workspaceId: string,
    runId: string,
    expected: number,
  ): Promise<void> {
    const prefix = `${DEMO_SESSION_PREFIX}${runId}_s`;
    const deadline = Date.now() + 15_000;
    do {
      const rows = await this.clickhouse.queryWorkspace<{ c: string }>(
        workspaceId,
        `SELECT count() AS c FROM sessions WHERE startsWith(id, {p:String})`,
        { p: prefix },
      );
      // Expect roughly `expected` distinct sessions; settle once we have ≥90%.
      if (Number(rows[0]?.c ?? 0) >= Math.floor(expected * 0.9)) return;
      if (Date.now() >= deadline) return;
      await sleep(300);
    } while (Date.now() < deadline);
  }

  /**
   * Synthetic completed backfill task so the demo data shows filters "synced"
   * (no "Filters out of sync" warning). Tagged via `error_message` so the wipe
   * can find and remove exactly the tasks it created.
   */
  private async createSyntheticBackfillTask(
    workspaceId: string,
    sessions: number,
    events: number,
  ): Promise<void> {
    const now = toClickHouseDateTime();
    const task: BackfillTask = {
      id: randomUUID(),
      workspace_id: workspaceId,
      status: 'completed',
      lookback_days: 30,
      chunk_size_days: 1,
      batch_size: INSERT_BATCH,
      total_sessions: sessions,
      processed_sessions: sessions,
      total_events: events,
      processed_events: events,
      current_date_chunk: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      completed_at: now,
      error_message: DEMO_BACKFILL_TAG,
      retry_count: 0,
      filters_snapshot: '[]',
    };
    await this.clickhouse.insertSystem('backfill_tasks', [task]);
  }
}

/** Tag stored in backfill_tasks.error_message so the wipe can target them. */
const DEMO_BACKFILL_TAG = 'vrddemo_synthetic_backfill';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(v)));
}
function totalRows(c: RowCounts): number {
  return c.events + c.sessions + c.pages + c.goals;
}
function sameCounts(a: RowCounts, b: RowCounts): boolean {
  return (
    a.events === b.events &&
    a.sessions === b.sessions &&
    a.pages === b.pages &&
    a.goals === b.goals
  );
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
