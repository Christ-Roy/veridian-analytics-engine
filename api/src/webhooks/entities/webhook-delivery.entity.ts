/**
 * Webhook delivery entity — mirrors `staminads_system.webhook_deliveries`.
 * One row per delivery attempt. Retries create new rows with incremented
 * `attempt`. Status transitions:
 *
 *   pending → success
 *   pending → retrying (attempt < max_attempts on 5xx/timeout/429)
 *   pending → failed   (4xx non-429 — no retry)
 *   pending → gave_up  (attempt == max_attempts, all failed)
 *
 * TTL 30d at the DB level (cf v7 migration).
 */

export type DeliveryStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'retrying'
  | 'gave_up';

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  workspace_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  scheduled_at: string;
  sent_at: string | null;
  status: DeliveryStatus;
  http_status: number | null;
  latency_ms: number | null;
  request_url: string;
  request_body: string;
  response_body: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}
