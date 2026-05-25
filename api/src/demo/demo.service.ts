import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClickHouseService } from '../database/clickhouse.service';
import { generateId, hashPassword } from '../common/crypto';
import {
  generateEventsByDay,
  getCachedFilters,
  clearFilterCache,
} from './fixtures/generators';
import { generateVoipCalls } from './fixtures/voip-calls';
import { TrackingEvent } from '../events/entities/event.entity';
import { DEMO_CUSTOM_DIMENSION_LABELS } from './fixtures/demo-filters';
import { BackfillTask } from '../filters/backfill/backfill-task.entity';
import {
  Annotation,
  WorkspaceSettings,
  DEFAULT_WORKSPACE_SETTINGS,
} from '../workspaces/entities/workspace.entity';
import { toClickHouseDateTime } from '../common/utils/datetime.util';

export const DEMO_WORKSPACE_ID = 'demo-apple';
export const DEMO_WORKSPACE_NAME = 'Veridian Analytics Demo';
export const DEMO_WEBSITE = 'https://www.apple.com';
export const DEMO_USER_EMAIL = 'demo@veridian.site';
export const DEMO_USER_NAME = 'Visiteur Démo';
const SESSION_COUNT = 200_000;
const DAYS_RANGE = 90;
const BATCH_SIZE = 10_000;

interface WorkspaceRow {
  id: string;
  name: string;
  website: string;
  timezone: string;
  currency: string;
  logo_url: string | null;
  settings: string; // JSON string
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Generate demo annotations that correlate with demo data patterns.
 */
function generateDemoAnnotations(endDate: Date): Annotation[] {
  // iPhone launch date: 5 days before end date (matches the 3x traffic spike in demo data)
  const launchDate = new Date(endDate);
  launchDate.setDate(launchDate.getDate() - 5);
  const launchDateStr = launchDate.toISOString().split('T')[0];

  return [
    {
      id: randomUUID(),
      date: launchDateStr,
      time: '10:00',
      timezone: 'America/Los_Angeles',
      title: 'iPhone 16 Launch',
      description: 'Apple keynote and product availability',
      color: '#22c55e', // Green (positive events)
    },
  ];
}

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(private readonly clickhouse: ClickHouseService) {}

  async generate() {
    const startTime = Date.now();

    // Clear filter cache to ensure fresh filter IDs for this generation
    clearFilterCache();

    // Delete existing demo workspace if it exists
    await this.deleteExistingDemo();

    // Generate events day-by-day using streaming generator
    const endDate = new Date();

    // Ensure the demo user exists BEFORE creating workspace, so they are
    // recorded as the owner of the demo workspace (used for anonymous
    // auto-login on the public demo instance).
    await this.ensureDemoUser();

    // Mark the instance as "set up" so the SPA does not redirect visitors to
    // the /setup wizard. On a public demo there is no human admin to run
    // setup.initialize — the demo seed IS the provisioning step.
    await this.ensureSetupComplete();

    // Create new workspace with fixed ID (needs endDate for annotations)
    await this.createWorkspace(DEMO_WORKSPACE_ID, endDate);

    this.logger.log(`Created workspace: ${DEMO_WORKSPACE_ID}`);
    this.logger.log(
      `Generating ${SESSION_COUNT.toLocaleString()} sessions over ${DAYS_RANGE} days...`,
    );

    const generator = generateEventsByDay({
      workspaceId: DEMO_WORKSPACE_ID,
      sessionCount: SESSION_COUNT,
      endDate,
      daysRange: DAYS_RANGE,
    });

    let totalEvents = 0;
    let totalSessions = 0;
    let dayCount = 0;

    for (const dayBatch of generator) {
      dayCount++;
      totalSessions += dayBatch.sessionCount;

      // Insert this day's events in sub-batches
      await this.insertEventsBatched(DEMO_WORKSPACE_ID, dayBatch.events);
      totalEvents += dayBatch.events.length;

      // Log progress every 10 days
      if (dayCount % 10 === 0 || dayCount === DAYS_RANGE) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(totalSessions / parseFloat(elapsed));
        this.logger.log(
          `Day ${dayCount}/${DAYS_RANGE}: ${totalSessions.toLocaleString()} sessions, ` +
            `${totalEvents.toLocaleString()} events (${rate} sessions/s)`,
        );
      }
    }

    // Seed fake VoIP calls (vision Veridian 2026-05-25). On insère des
    // events `phone_call` (goals natifs staminads) avec `properties.source`
    // pour que la démo affiche la feature Calls dans Live / Explore / Goals.
    // Le seed est gated implicitement par le scope de `demo.generate()` —
    // l'endpoint exige `DEMO_SECRET` et n'est armé que sur `IS_DEMO=true`.
    const voipEventsCount = await this.seedVoipCalls(
      DEMO_WORKSPACE_ID,
      endDate,
    );
    totalEvents += voipEventsCount;

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    this.logger.log(`Demo generation completed in ${duration}s`);

    // Create a completed backfill task to mark filters as synced
    await this.createCompletedBackfillTask(
      DEMO_WORKSPACE_ID,
      totalSessions,
      totalEvents,
    );

    // Calculate date range
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - DAYS_RANGE);

    return {
      workspace_id: DEMO_WORKSPACE_ID,
      workspace_name: DEMO_WORKSPACE_NAME,
      events_count: totalEvents,
      sessions_count: totalSessions,
      voip_calls_count: voipEventsCount,
      date_range: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      },
      generation_time_seconds: parseFloat(duration),
    };
  }

  /**
   * Génère ~30 appels VoIP factices (events `phone_call`) répartis sur 30j
   * et les insère dans ClickHouse. Conçu pour la démo publique : le bridge
   * Postgres n'existe pas dans `compose/demo.yml`, donc on contourne en
   * insérant les events directement (comme le ferait `voip/sync.ts` côté
   * prod via `POST /api/track`).
   *
   * Idempotent : un re-seed (cron nuit) écrase les events précédents grâce
   * aux `dedup_token` natifs staminads.
   *
   * @returns nombre d'événements insérés.
   */
  private async seedVoipCalls(
    workspaceId: string,
    endDate: Date,
  ): Promise<number> {
    const voipEvents = generateVoipCalls({
      workspaceId,
      endDate,
      daysRange: DAYS_RANGE,
      callCount: 30,
    });
    if (voipEvents.length === 0) {
      return 0;
    }
    await this.clickhouse.insertWorkspace(workspaceId, 'events', voipEvents);
    this.logger.log(
      `Seeded ${voipEvents.length} VoIP phone_call events for demo`,
    );
    return voipEvents.length;
  }

  async delete() {
    const deleted = await this.deleteExistingDemo();

    if (deleted) {
      return {
        success: true,
        message: 'Demo workspace and database deleted',
      };
    }

    return {
      success: true,
      message: 'No demo workspace found',
    };
  }

  private async deleteExistingDemo(): Promise<boolean> {
    // Check if demo workspace exists in system database
    const workspaces = await this.clickhouse.querySystem<{ id: string }>(
      `SELECT id FROM workspaces WHERE id = {id:String} LIMIT 1`,
      { id: DEMO_WORKSPACE_ID },
    );

    if (workspaces.length === 0) {
      return false;
    }

    // Drop workspace database (cascades to all tables - events, sessions, etc.)
    await this.clickhouse.dropWorkspaceDatabase(DEMO_WORKSPACE_ID);

    // Delete workspace row from system database
    await this.clickhouse.commandSystem(
      `ALTER TABLE workspaces DELETE WHERE id = '${DEMO_WORKSPACE_ID}'`,
    );

    // Delete backfill tasks for this workspace from system database
    await this.clickhouse.commandSystem(
      `ALTER TABLE backfill_tasks DELETE WHERE workspace_id = '${DEMO_WORKSPACE_ID}'`,
    );

    this.logger.log(`Deleted existing demo workspace: ${DEMO_WORKSPACE_ID}`);

    return true;
  }

  private async createWorkspace(
    workspaceId: string,
    endDate: Date,
  ): Promise<WorkspaceRow> {
    const now = toClickHouseDateTime();

    // Build settings with demo-specific values
    const settings: WorkspaceSettings = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      timescore_reference: 180, // 3 minutes
      bounce_threshold: 10,
      custom_dimensions: DEMO_CUSTOM_DIMENSION_LABELS,
      filters: getCachedFilters().filters,
      annotations: generateDemoAnnotations(endDate),
      allowed_domains: ['*.apple.com'],
    };

    const workspace: WorkspaceRow = {
      id: workspaceId,
      name: DEMO_WORKSPACE_NAME,
      website: DEMO_WEBSITE,
      timezone: 'America/New_York',
      currency: 'USD',
      logo_url:
        'https://www.apple.com/ac/structured-data/images/knowledge_graph_logo.png',
      settings: JSON.stringify(settings),
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    // Create workspace database first
    await this.clickhouse.createWorkspaceDatabase(workspaceId);

    // Insert workspace row into system database
    await this.clickhouse.insertSystem('workspaces', [workspace]);

    // Add super_admin user as owner to workspace_memberships
    await this.addSuperAdminAsOwner(workspaceId, now);

    return workspace;
  }

  /**
   * Find an owner for the demo workspace.
   *
   * Priority:
   * 1. The dedicated demo user `demo@veridian.site` (created by
   *    `ensureDemoUser`). This is the user the public demo instance
   *    auto-logs visitors in as, so they MUST be the owner of the demo
   *    workspace for `workspaces.list` to return it.
   * 2. Fallback: any active super_admin user (when running locally
   *    without a dedicated demo user, e.g. dev seed).
   */
  private async addSuperAdminAsOwner(
    workspaceId: string,
    now: string,
  ): Promise<void> {
    // Try the dedicated demo user first
    const demoUsers = await this.clickhouse.querySystem<{ id: string }>(
      `SELECT id FROM users FINAL WHERE email = {email:String} AND status = 'active' LIMIT 1`,
      { email: DEMO_USER_EMAIL },
    );

    let ownerId: string | null = demoUsers[0]?.id ?? null;
    let ownerLabel = `demo user ${DEMO_USER_EMAIL}`;

    if (!ownerId) {
      // Fallback: super_admin
      const superAdmins = await this.clickhouse.querySystem<{ id: string }>(
        `SELECT id FROM users FINAL WHERE is_super_admin = 1 AND status = 'active' LIMIT 1`,
      );
      ownerId = superAdmins[0]?.id ?? null;
      ownerLabel = `super_admin ${ownerId ?? '<none>'}`;
    }

    if (!ownerId) {
      this.logger.warn(
        'No demo user or super_admin found - demo workspace will have no owner',
      );
      return;
    }

    await this.clickhouse.insertSystem('workspace_memberships', [
      {
        id: generateId(),
        workspace_id: workspaceId,
        user_id: ownerId,
        role: 'owner',
        invited_by: null,
        joined_at: now,
        created_at: now,
        updated_at: now,
      },
    ]);

    this.logger.log(`Added ${ownerLabel} as owner of ${workspaceId}`);
  }

  /**
   * Idempotently create the public demo user `demo@veridian.site`.
   *
   * This user is the identity that anonymous visitors of the public demo
   * instance are auto-logged in as via `POST /api/demo.login`. The user has
   * no super_admin flag (so the "New workspace" UI element is hidden) and
   * a random untouchable password (login is only ever issued through
   * `demo.login`, never through `auth.login`).
   *
   * Returns the user id.
   */
  async ensureDemoUser(): Promise<string> {
    const existing = await this.clickhouse.querySystem<{ id: string }>(
      `SELECT id FROM users FINAL WHERE email = {email:String} LIMIT 1`,
      { email: DEMO_USER_EMAIL },
    );

    if (existing.length > 0) {
      return existing[0].id;
    }

    const id = generateId();
    // Generate a random password the demo user cannot use to actually log in
    // through /api/auth.login. The demo.login endpoint bypasses password
    // verification entirely. We still hash a value so password_hash is not
    // empty (defense in depth: even if demo.login were ever exposed in a
    // non-demo build, no real password matches this hash).
    const passwordHash = await hashPassword(randomUUID() + randomUUID());
    const now = toClickHouseDateTime();

    await this.clickhouse.insertSystem('users', [
      {
        id,
        email: DEMO_USER_EMAIL,
        password_hash: passwordHash,
        name: DEMO_USER_NAME,
        type: 'user',
        status: 'active',
        is_super_admin: 0,
        last_login_at: null,
        failed_login_attempts: 0,
        locked_until: null,
        password_changed_at: now,
        deleted_at: null,
        deleted_by: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    this.logger.log(`Created demo user ${DEMO_USER_EMAIL} (id=${id})`);
    return id;
  }

  /**
   * Lookup the demo user. Returns null if the user has not been seeded yet
   * (caller should respond with 503 in that case so the frontend can poll).
   */
  async findDemoUser(): Promise<{
    id: string;
    email: string;
    name: string;
  } | null> {
    const rows = await this.clickhouse.querySystem<{
      id: string;
      email: string;
      name: string;
    }>(
      `SELECT id, email, name FROM users FINAL WHERE email = {email:String} AND status = 'active' LIMIT 1`,
      { email: DEMO_USER_EMAIL },
    );

    return rows[0] ?? null;
  }

  /**
   * Idempotently set the `setup_completed` system flag.
   *
   * The public demo instance has no human operator to walk through the
   * /setup wizard. Without this flag, `SetupMiddleware` answers 503 on every
   * /api/* call and the SPA bounces visitors to /setup. Since the demo seed
   * provisions the workspace and demo user itself, it also owns marking
   * setup as complete.
   *
   * `system_settings` is a ReplacingMergeTree keyed on `key`, so re-inserting
   * the same row on every re-seed is safe (idempotent).
   */
  private async ensureSetupComplete(): Promise<void> {
    await this.clickhouse.insertSystem('system_settings', [
      {
        key: 'setup_completed',
        value: 'true',
        updated_at: toClickHouseDateTime(),
      },
    ]);
    this.logger.log('Marked setup_completed=true for demo instance');
  }

  private async insertEventsBatched(
    workspaceId: string,
    events: TrackingEvent[],
  ): Promise<void> {
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);

      // Insert to workspace database
      await this.clickhouse.insertWorkspace(workspaceId, 'events', batch);
    }
  }

  /**
   * Create a synthetic completed backfill task to mark filters as synced.
   * Since demo data is generated with filters already applied, we create
   * a completed task record to prevent "Filters out of sync" warning.
   */
  private async createCompletedBackfillTask(
    workspaceId: string,
    sessionsCount: number,
    eventsCount: number,
  ): Promise<void> {
    const { filters } = getCachedFilters();
    const now = toClickHouseDateTime();

    const task: BackfillTask = {
      id: randomUUID(),
      workspace_id: workspaceId,
      status: 'completed',
      lookback_days: DAYS_RANGE,
      chunk_size_days: 1,
      batch_size: BATCH_SIZE,
      total_sessions: sessionsCount,
      processed_sessions: sessionsCount,
      total_events: eventsCount,
      processed_events: eventsCount,
      current_date_chunk: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      completed_at: now,
      error_message: null,
      retry_count: 0,
      filters_snapshot: JSON.stringify(filters),
    };

    await this.clickhouse.insertSystem('backfill_tasks', [task]);
    this.logger.log('Created completed backfill task for demo workspace');
  }
}
