import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookDefinition } from '../entities/webhook-definition.entity';
import { WebhookDelivery } from '../entities/webhook-delivery.entity';
import {
  TwentyEventMapper,
  TrackedEventContext,
  MappedTimelineEvent,
} from './twenty-event-mapper';
import { TwentyClient } from './twenty-client';
import { TwentyBudget } from './twenty-budget';
import { deterministicTimelineId } from './deterministic-id';
import { SsrfGuard } from '../../common/ssrf-guard';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import type { WorkspaceCrmMapping } from '../../workspaces/entities/workspace.entity';

/**
 * TwentyConnectorService — the engine-native Twenty destination (design B,
 * modèle Segment/PostHog). Re-implements the micro-service `bridge/src/writer.ts`
 * timeline path inside the webhooks module.
 *
 * Unlike a plain webhook (1 delivery → 1 POST), the Twenty destination BATCHES
 * deliveries: it resolves the target Person, groups up to 60 timeline activities
 * per call (§4c.2), and respects the ≤100 req/min budget (§4c.2). Each delivery
 * is then marked success / orphan / failed individually.
 *
 * Multi-tenant: the TwentyClient is built per webhook from that workspace's own
 * url (base) + decrypted Bearer. No shared singleton, no cross-tenant bleed.
 *
 * DRY_RUN: per-webhook via transform.dry_run (gate à blanc) OR globally via
 * TWENTY_CONNECTOR_DRY_RUN. Reads (Person resolution) stay real, writes logged.
 */

export interface ConnectorOutcome {
  /** delivery ids successfully written (or dry-run accepted) to a timeline batch */
  written: string[];
  /** delivery ids whose Person could not be resolved — left for the reconcile */
  orphans: string[];
  /** delivery ids that failed (mapping error, budget exhausted, batch error) */
  failed: string[];
  /** delivery ids skipped (not a timeline milestone) — treated as success no-op */
  skipped: string[];
}

const BATCH_SIZE = 60; // §4c.2
const PERSON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Default hard cap on the Person resolution cache. The key embeds the visitor
 * identity (email / slug), so on a high-traffic workspace the number of distinct
 * keys is effectively unbounded — TTL only governs reuse, it never evicts.
 * Without a size cap the Map grows forever → slow OOM. We evict oldest-first
 * (insertion order) once the cap is hit, same pattern as GeoService.
 * Overridable via TWENTY_PERSON_CACHE_MAX_SIZE.
 */
const DEFAULT_PERSON_CACHE_MAX_SIZE = 50_000;
/** crm_mapping config cache TTL — config changes rarely; a flush is a tick. */
const CRM_CONFIG_CACHE_TTL_MS = 60 * 1000;

interface CachedPerson {
  id: string;
  resolvedAt: number;
}

interface CachedCrmConfig {
  config: WorkspaceCrmMapping | undefined;
  resolvedAt: number;
}

/** Discriminated result of a Person resolution attempt. */
type PersonResolution =
  | { status: 'found'; personId: string }
  | { status: 'not_found' }
  | { status: 'no_budget' };

@Injectable()
export class TwentyConnectorService {
  private readonly logger = new Logger(TwentyConnectorService.name);
  /** Person resolution cache, keyed by `${workspace_id}:${kind}:${identity}` (tenant-scoped). */
  private readonly personCache = new Map<string, CachedPerson>();
  /** Per-workspace crm_mapping config cache (60s TTL). */
  private readonly crmConfigCache = new Map<string, CachedCrmConfig>();
  /** Hard size cap for personCache (oldest-first eviction). ENV-overridable. */
  private readonly personCacheMaxSize: number;

  constructor(
    private readonly mapper: TwentyEventMapper,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspacesService,
    private readonly ssrf: SsrfGuard,
  ) {
    const raw = parseInt(
      this.config.get<string>('TWENTY_PERSON_CACHE_MAX_SIZE') || '',
      10,
    );
    this.personCacheMaxSize =
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PERSON_CACHE_MAX_SIZE;
  }

  /** Test/observability seam — current Person cache size. */
  getPersonCacheSize(): number {
    return this.personCache.size;
  }

  /** True when a webhook is a Twenty destination. */
  static isTwentyDestination(webhook: WebhookDefinition): boolean {
    return webhook.transform?.type === 'twenty';
  }

  /**
   * Build the per-tenant Twenty client from the webhook definition.
   *
   * ⚠️ SSRF choke point. The TwentyClient fetches `webhook.url` at runtime
   * (resolvePerson / batchTimeline / reachable), so — exactly like the generic
   * delivery path guards inside `sendOne` — we resolve + vet the base URL HERE,
   * before any client exists. This closes the DNS-rebinding window between
   * webhook CREATION (validated literal-only at CRUD) and the actual push: a
   * public-looking host that re-resolves to 127.0.0.1 / 169.254.169.254 / RFC1918
   * is rejected before a single fetch. All three client methods hit the same
   * host (`new URL(path, baseUrl)`), so one resolution covers them. Making this
   * the connector's own guard means no caller can bypass it (the worker no longer
   * needs a separate guard — single choke point, same pattern as `sendOne`).
   *
   * @param secret decrypted Bearer (caller decrypts via WebhooksService).
   * @throws ForbiddenException (SSRF) when the resolved target is private/loopback.
   */
  async buildClient(webhook: WebhookDefinition, secret: string): Promise<TwentyClient> {
    await this.ssrf.assertSafeUrlResolved(webhook.url, {
      allowHttp: this.config.get<string>('WEBHOOK_ALLOW_HTTP') === 'true',
      allowPrivate: this.config.get<string>('WEBHOOK_ALLOW_PRIVATE_IPS') === 'true',
    });
    const transform = webhook.transform as { type: 'twenty'; dry_run?: boolean } | null;
    const dryRun =
      transform?.dry_run === true ||
      this.config.get<string>('TWENTY_CONNECTOR_DRY_RUN') === 'true';
    return new TwentyClient({
      baseUrl: webhook.url,
      bearer: secret,
      dryRun,
    });
  }

  /**
   * Push a batch of ready deliveries for ONE Twenty webhook.
   *
   * Steps (mirrors writer.flushOnce, §4c):
   *   1. map each delivery's event → timeline name + identity (skip non-milestones)
   *   2. resolve Person (cache TTL 24h) — orphan when not found
   *   3. batch ≤60 → POST /rest/batch/timelineActivities (1 budget token)
   *   4. classify each delivery: written / orphan / failed / skipped
   *
   * @param budget shared minute budget (timeline has priority over score push).
   */
  async flushBatch(
    webhook: WebhookDefinition,
    deliveries: WebhookDelivery[],
    client: TwentyClient,
    budget: TwentyBudget,
  ): Promise<ConnectorOutcome> {
    const outcome: ConnectorOutcome = {
      written: [],
      orphans: [],
      failed: [],
      skipped: [],
    };
    if (deliveries.length === 0) return outcome;

    // Fetch the workspace's CRM mapping ONCE per flush (cached 60s). Drives the
    // generic mapping (N4) + identity resolution; undefined → built-in fallback.
    const crmConfig = await this.getCrmConfig(webhook.workspace_id);

    const activities: Array<{ deliveryId: string; mapped: MappedTimelineEvent; personId: string }> = [];

    for (const delivery of deliveries) {
      const mappedList = this.mapDelivery(webhook, delivery, crmConfig);
      if (mappedList.length === 0) {
        // Not a timeline milestone (raw noise / unknown goal / no identity).
        // Treated as a success no-op so the delivery is not retried forever.
        outcome.skipped.push(delivery.id);
        continue;
      }

      // All milestones of one delivery share the same identity → resolve once.
      let resolution: PersonResolution;
      try {
        resolution = await this.resolvePersonId(
          webhook.workspace_id,
          mappedList[0],
          client,
          budget,
        );
      } catch (err) {
        this.logger.warn(
          `Twenty resolve failed (ws=${webhook.workspace_id}, id=${mappedList[0].identity}): ${(err as Error).message}`,
        );
        outcome.failed.push(delivery.id);
        continue;
      }
      if (resolution.status === 'no_budget') {
        // No token for the resolution → retry next tick (not a failure).
        outcome.failed.push(delivery.id);
        continue;
      }
      if (resolution.status === 'not_found') {
        // Person genuinely not found → orphan (import batch may run later).
        outcome.orphans.push(delivery.id);
        continue;
      }

      // Respect the ≤60 activities/call cap (a delivery may yield 2 milestones).
      // If this delivery's milestones would overflow the batch, stop here and
      // leave the rest pending for the next tick (they were not classified).
      if (activities.length + mappedList.length > BATCH_SIZE) break;
      for (const mapped of mappedList) {
        activities.push({ deliveryId: delivery.id, mapped, personId: resolution.personId });
      }
    }

    if (activities.length === 0) return outcome;

    if (!budget.take()) {
      // No token for the batch POST → all candidates stay pending for next tick.
      for (const id of new Set(activities.map((a) => a.deliveryId))) outcome.failed.push(id);
      return outcome;
    }

    try {
      await client.batchTimeline(
        activities.map((a) => ({
          // Deterministic id keyed by (personId, eventId, name): exactly-once on
          // replay (#9/#12) AND no cross-Person collision when the same event is
          // re-attributed slug→email → two Person → two ids (#13).
          id: deterministicTimelineId(a.personId, a.mapped.eventId, a.mapped.name),
          name: a.mapped.name,
          happensAt: a.mapped.happensAt,
          targetPersonId: a.personId,
          properties: a.mapped.properties,
        })),
      );
      // One delivery may have produced several activities → dedup ids.
      for (const id of new Set(activities.map((a) => a.deliveryId))) outcome.written.push(id);
    } catch (err) {
      this.logger.error(`Twenty batchTimeline failed (ws=${webhook.workspace_id}): ${(err as Error).message}`);
      for (const id of new Set(activities.map((a) => a.deliveryId))) outcome.failed.push(id);
    }

    return outcome;
  }

  /**
   * Map a stored delivery (request_body holds the tracked-event payload) to its
   * timeline milestones (0, 1 or 2) via the pure mapper.
   */
  private mapDelivery(
    webhook: WebhookDefinition,
    delivery: WebhookDelivery,
    crmConfig: WorkspaceCrmMapping | undefined,
  ): MappedTimelineEvent[] {
    const payload = this.parseBody(delivery.request_body);
    const ctx: TrackedEventContext = {
      workspace_id: webhook.workspace_id,
      event_type: delivery.event_type,
      event_id: delivery.event_id,
      // The dispatcher stores the enriched ctx (payload + event_type/id/ws) as
      // request_body; the mapper reads payload fields (path, goal_name, user_id…).
      payload,
    };
    return this.mapper.mapAll(ctx, crmConfig);
  }

  /**
   * Read (and cache 60s) a workspace's CRM mapping config. A missing workspace
   * or empty config yields `undefined` → the mapper falls back to the built-in
   * prospection mapping (back-compat). Never throws — a config read failure must
   * not break delivery (the fallback still works).
   */
  private async getCrmConfig(
    workspaceId: string,
  ): Promise<WorkspaceCrmMapping | undefined> {
    const cached = this.crmConfigCache.get(workspaceId);
    if (cached && Date.now() - cached.resolvedAt < CRM_CONFIG_CACHE_TTL_MS) {
      return cached.config;
    }
    let config: WorkspaceCrmMapping | undefined;
    try {
      const ws = await this.workspaces.get(workspaceId);
      config = ws.settings?.crm_mapping;
    } catch (err) {
      this.logger.warn(
        `crm_mapping read failed (ws=${workspaceId}): ${(err as Error).message} — using fallback`,
      );
      config = undefined;
    }
    this.crmConfigCache.set(workspaceId, { config, resolvedAt: Date.now() });
    return config;
  }

  /**
   * Resolve + cache a Person id. Returns a discriminated result so the caller
   * never has to guess WHY resolution did not yield an id:
   *   - found     → personId (from cache or a fresh lookup)
   *   - not_found → the Person genuinely does not exist yet (orphan)
   *   - no_budget → no token left for the lookup (retry next tick, NOT an orphan)
   */
  private async resolvePersonId(
    workspaceId: string,
    mapped: MappedTimelineEvent,
    client: TwentyClient,
    budget: TwentyBudget,
  ): Promise<PersonResolution> {
    // Cache key includes the resolution kind/field so two workspaces (or two
    // identity strategies) never collide on the same identity string.
    const key = `${workspaceId}:${mapped.identityKind}:${mapped.identityField ?? ''}:${mapped.identity}`;
    const cached = this.personCache.get(key);
    if (cached && Date.now() - cached.resolvedAt < PERSON_CACHE_TTL_MS) {
      return { status: 'found', personId: cached.id };
    }
    if (!budget.take()) return { status: 'no_budget' };
    const person = await client.resolvePerson(
      mapped.identity,
      mapped.identityKind,
      mapped.identityField,
    );
    if (!person) return { status: 'not_found' };
    this.cachePerson(key, person.id);
    return { status: 'found', personId: person.id };
  }

  /**
   * Insert into the Person cache with a hard size cap (evict oldest-first).
   * A Map preserves insertion order, so the first key is the oldest. Mirrors
   * GeoService's bounded-cache pattern to keep memory flat under high traffic.
   */
  private cachePerson(key: string, id: string): void {
    if (
      this.personCache.size >= this.personCacheMaxSize &&
      !this.personCache.has(key)
    ) {
      const oldest = this.personCache.keys().next().value;
      if (oldest !== undefined) this.personCache.delete(oldest);
    }
    this.personCache.set(key, { id, resolvedAt: Date.now() });
  }

  private parseBody(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Test seam — clears the per-tenant Person cache + crm config cache. */
  clearCache(): void {
    this.personCache.clear();
    this.crmConfigCache.clear();
  }
}
