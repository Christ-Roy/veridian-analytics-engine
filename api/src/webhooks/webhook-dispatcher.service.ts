import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebhooksService } from './webhooks.service';
import { WebhookFilterEngine } from './webhook-filter-engine';

/**
 * Payload emitted by `session-payload.handler` after a successful ClickHouse
 * insert. Kept minimal — we only need enough to evaluate filters and ship
 * the event downstream.
 */
export interface TrackedEventPayload {
  workspace_id: string;
  event_type: string;
  event_id: string;
  payload: Record<string, unknown>;
}

/**
 * Async fan-out: every tracked event is matched against the workspace's
 * active webhooks. Matching webhooks get a pending delivery inserted into
 * `webhook_deliveries`; the worker (cf webhook-delivery-worker.service.ts)
 * picks them up on its next tick.
 *
 * Fail-soft: any error is logged but never thrown back to the event emitter
 * so the ingestion pipeline stays unaffected (cf PATTERNS-WEBHOOKS.md §4).
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly filterEngine: WebhookFilterEngine,
  ) {}

  @OnEvent('event.tracked', { async: true, promisify: true })
  async dispatch(event: TrackedEventPayload): Promise<void> {
    try {
      await this.dispatchInternal(event);
    } catch (err) {
      this.logger.error(
        `dispatch failed for workspace ${event.workspace_id} / event ${event.event_id}: ${(err as Error).message}`,
      );
    }
  }

  async dispatchInternal(event: TrackedEventPayload): Promise<void> {
    const webhooks = await this.webhooksService.findActive(event.workspace_id);
    if (webhooks.length === 0) return;

    for (const webhook of webhooks) {
      if (webhook.events.length > 0 && !webhook.events.includes(event.event_type)) {
        continue;
      }
      const ctx = {
        ...event.payload,
        event_type: event.event_type,
        event_id: event.event_id,
        workspace_id: event.workspace_id,
      };
      if (!this.filterEngine.matches(webhook.filters, ctx)) continue;

      await this.webhooksService.enqueueDelivery(webhook, {
        event_id: event.event_id,
        event_type: event.event_type,
        payload: ctx,
      });
    }
  }
}
