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

interface CachedPerson {
  id: string;
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
  /** Person resolution cache, keyed by `${workspace_id}:${identity}` (tenant-scoped). */
  private readonly personCache = new Map<string, CachedPerson>();

  constructor(
    private readonly mapper: TwentyEventMapper,
    private readonly config: ConfigService,
  ) {}

  /** True when a webhook is a Twenty destination. */
  static isTwentyDestination(webhook: WebhookDefinition): boolean {
    return webhook.transform?.type === 'twenty';
  }

  /**
   * Build the per-tenant Twenty client from the webhook definition.
   * @param secret decrypted Bearer (caller decrypts via WebhooksService).
   */
  buildClient(webhook: WebhookDefinition, secret: string): TwentyClient {
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

    const activities: Array<{ deliveryId: string; mapped: MappedTimelineEvent; personId: string }> = [];

    for (const delivery of deliveries) {
      const mappedList = this.mapDelivery(webhook, delivery);
      if (mappedList.length === 0) {
        // Not a timeline milestone (raw noise / unknown goal / no identity).
        // Treated as a success no-op so the delivery is not retried forever.
        outcome.skipped.push(delivery.id);
        continue;
      }

      // All milestones of one delivery share the same identity → resolve once.
      let resolution: PersonResolution;
      try {
        resolution = await this.resolvePersonId(webhook.workspace_id, mappedList[0].identity, client, budget);
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
    return this.mapper.mapAll(ctx);
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
    identity: string,
    client: TwentyClient,
    budget: TwentyBudget,
  ): Promise<PersonResolution> {
    const key = `${workspaceId}:${identity}`;
    const cached = this.personCache.get(key);
    if (cached && Date.now() - cached.resolvedAt < PERSON_CACHE_TTL_MS) {
      return { status: 'found', personId: cached.id };
    }
    if (!budget.take()) return { status: 'no_budget' };
    const person = await client.resolvePerson(identity);
    if (!person) return { status: 'not_found' };
    this.personCache.set(key, { id: person.id, resolvedAt: Date.now() });
    return { status: 'found', personId: person.id };
  }

  private parseBody(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Test seam — clears the per-tenant Person cache. */
  clearCache(): void {
    this.personCache.clear();
  }
}
