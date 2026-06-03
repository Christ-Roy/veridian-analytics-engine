/**
 * Webhook definition entity — mirrors `staminads_system.webhook_definitions`.
 * Stored fields (events, filters, transform, retry_config) are persisted as
 * JSON strings in ClickHouse; the service parses them on read and
 * serializes on write.
 */

export type WebhookAuthType = 'none' | 'bearer' | 'basic' | 'hmac';
export type WebhookStatus = 'active' | 'inactive';

export type FilterOp = 'equals' | 'matches' | 'in' | 'gt' | 'lt';

export interface WebhookFilter {
  field: string;
  op: FilterOp;
  value: string | number | string[] | number[];
}

export interface WebhookTransformPassthrough {
  type: 'passthrough';
}

export interface WebhookTransformTemplate {
  type: 'template';
  /** Handlebars template (cf PATTERNS-WEBHOOKS.md §7). */
  template: string;
}

export type WebhookTransform =
  | WebhookTransformPassthrough
  | WebhookTransformTemplate
  | null;

export interface WebhookRetryConfig {
  max_attempts: number;
  /** Backoff per attempt in milliseconds (index 0 = first retry). */
  backoff_ms: number[];
}

export const DEFAULT_RETRY_CONFIG: WebhookRetryConfig = {
  max_attempts: 3,
  backoff_ms: [60_000, 300_000, 900_000],
};

export interface WebhookDefinition {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  active: boolean;
  auth_type: WebhookAuthType;
  /** ENCRYPTED at rest. Never returned via public APIs. */
  auth_secret_encrypted: string;
  events: string[];
  filters: WebhookFilter[];
  transform: WebhookTransform;
  retry_config: WebhookRetryConfig;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Webhook returned to API consumers (auth_secret masked). */
export type PublicWebhookDefinition = Omit<
  WebhookDefinition,
  'auth_secret_encrypted'
> & {
  auth: {
    type: WebhookAuthType;
    /** Whether a secret is stored. The actual value is never returned. */
    has_secret: boolean;
  };
};
