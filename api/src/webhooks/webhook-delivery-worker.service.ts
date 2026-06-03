import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { WebhooksService } from './webhooks.service';
import { WebhookTransformEngine } from './webhook-transform-engine';
import { WebhookSsrfGuard } from './webhook-ssrf-guard';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import {
  WebhookAuthType,
  WebhookDefinition,
} from './entities/webhook-definition.entity';
import { toClickHouseDateTime } from '../common/utils/datetime.util';
import { createHmac } from 'crypto';

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 64_000;

export interface DeliveryAttemptResult {
  success: boolean;
  http_status: number | null;
  latency_ms: number;
  response_body: string;
  error_message: string;
}

/**
 * Polls `webhook_deliveries` every 10s and pushes each ready row to its
 * destination. Cf PATTERNS-WEBHOOKS.md §5.
 *
 * Retry logic:
 *   - 2xx  → status=success
 *   - 4xx (not 429) → status=failed (no retry — wrong payload)
 *   - 429 / 5xx / timeout / network → status=retrying with backoff,
 *     until attempt == max_attempts → status=gave_up
 */
@Injectable()
export class WebhookDeliveryWorker {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private running = false;

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly transformEngine: WebhookTransformEngine,
    private readonly ssrf: WebhookSsrfGuard,
    private readonly config: ConfigService,
  ) {}

  /** Cron entry-point. Skipped while the previous tick is still running. */
  @Interval('webhook-delivery-tick', POLL_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drainQueue();
    } catch (err) {
      this.logger.error(`drainQueue failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async drainQueue(batchSize = 50): Promise<number> {
    const pending = await this.webhooks.findReadyDeliveries(batchSize);
    if (pending.length === 0) return 0;
    let processed = 0;
    for (const delivery of pending) {
      await this.deliverOne(delivery);
      processed += 1;
    }
    return processed;
  }

  async deliverOne(delivery: WebhookDelivery): Promise<void> {
    const webhook = await this.webhooks.findByIdInternal(delivery.webhook_id);
    if (!webhook) {
      await this.webhooks.updateDelivery({
        ...delivery,
        status: 'failed',
        error_message: 'webhook_definition not found (deleted?)',
      });
      return;
    }
    if (!webhook.active) {
      await this.webhooks.updateDelivery({
        ...delivery,
        status: 'failed',
        error_message: 'webhook is inactive',
      });
      return;
    }

    try {
      this.ssrf.assertSafeUrl(webhook.url, {
        allowHttp: this.httpAllowed(),
        allowPrivate: this.privateAllowed(),
      });
    } catch (err) {
      await this.webhooks.updateDelivery({
        ...delivery,
        status: 'failed',
        error_message: `ssrf: ${(err as Error).message}`,
      });
      return;
    }

    const result = await this.sendOne(webhook, delivery);
    await this.recordOutcome(webhook, delivery, result);
  }

  async sendOne(
    webhook: WebhookDefinition,
    delivery: WebhookDelivery,
  ): Promise<DeliveryAttemptResult> {
    const payload = this.parsePayload(delivery.request_body);
    let body: string;
    try {
      body = this.transformEngine.render(webhook.transform, payload);
    } catch (err) {
      return {
        success: false,
        http_status: null,
        latency_ms: 0,
        response_body: '',
        error_message: `transform_failed: ${(err as Error).message}`,
      };
    }

    const headers = this.buildHeaders(webhook, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      const latency = Date.now() - start;
      const text = await this.readBodySafely(res);
      return {
        success: res.ok,
        http_status: res.status,
        latency_ms: latency,
        response_body: text,
        error_message: res.ok ? '' : `HTTP ${res.status}`,
      };
    } catch (err) {
      const latency = Date.now() - start;
      const error = err as Error;
      return {
        success: false,
        http_status: null,
        latency_ms: latency,
        response_body: '',
        error_message:
          error.name === 'AbortError' ? 'timeout' : `network: ${error.message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordOutcome(
    webhook: WebhookDefinition,
    delivery: WebhookDelivery,
    result: DeliveryAttemptResult,
  ): Promise<void> {
    const sentAt = toClickHouseDateTime();
    if (result.success) {
      await this.webhooks.updateDelivery({
        ...delivery,
        status: 'success',
        sent_at: sentAt,
        http_status: result.http_status,
        latency_ms: result.latency_ms,
        response_body: this.truncate(result.response_body),
        error_message: '',
      });
      return;
    }

    const status = result.http_status;
    const isClient4xx = status !== null && status >= 400 && status < 500 && status !== 429;
    if (isClient4xx) {
      await this.webhooks.updateDelivery({
        ...delivery,
        status: 'failed',
        sent_at: sentAt,
        http_status: status,
        latency_ms: result.latency_ms,
        response_body: this.truncate(result.response_body),
        error_message: result.error_message,
      });
      return;
    }

    // 5xx, 429, timeout, network → retry path
    const nextAttempt = delivery.attempt + 1;
    const max = webhook.retry_config.max_attempts;
    if (nextAttempt > max) {
      await this.webhooks.updateDelivery({
        ...delivery,
        status: 'gave_up',
        sent_at: sentAt,
        http_status: status,
        latency_ms: result.latency_ms,
        response_body: this.truncate(result.response_body),
        error_message: result.error_message,
      });
      return;
    }
    const backoff =
      webhook.retry_config.backoff_ms[Math.min(delivery.attempt - 1, webhook.retry_config.backoff_ms.length - 1)] ??
      60_000;
    const nextSchedule = toClickHouseDateTime(new Date(Date.now() + backoff));
    await this.webhooks.updateDelivery({
      ...delivery,
      status: 'retrying',
      attempt: nextAttempt,
      scheduled_at: nextSchedule,
      sent_at: sentAt,
      http_status: status,
      latency_ms: result.latency_ms,
      response_body: this.truncate(result.response_body),
      error_message: result.error_message,
    });
  }

  buildHeaders(webhook: WebhookDefinition, body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'veridian-analytics-engine/webhooks-1.0',
      'x-webhook-id': webhook.id,
    };
    const secret = this.webhooks.decryptSecret(webhook);
    const auth = webhook.auth_type as WebhookAuthType;
    if (auth === 'bearer' && secret) {
      headers['authorization'] = `Bearer ${secret}`;
    } else if (auth === 'basic' && secret) {
      const encoded = Buffer.from(secret, 'utf8').toString('base64');
      headers['authorization'] = `Basic ${encoded}`;
    } else if (auth === 'hmac' && secret) {
      const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      headers['x-veridian-signature'] = `sha256=${signature}`;
    }
    return headers;
  }

  private async readBodySafely(res: Response): Promise<string> {
    try {
      const text = await res.text();
      return this.truncate(text);
    } catch {
      return '';
    }
  }

  private truncate(text: string): string {
    if (text.length <= RESPONSE_BODY_LIMIT) return text;
    return text.slice(0, RESPONSE_BODY_LIMIT) + '… [truncated]';
  }

  private parsePayload(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private httpAllowed(): boolean {
    return this.config.get<string>('WEBHOOK_ALLOW_HTTP') === 'true';
  }

  private privateAllowed(): boolean {
    return this.config.get<string>('WEBHOOK_ALLOW_PRIVATE_IPS') === 'true';
  }
}
