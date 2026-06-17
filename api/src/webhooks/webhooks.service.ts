import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClickHouseService } from '../database/clickhouse.service';
import { generateId } from '../common/crypto';
import { toClickHouseDateTime } from '../common/utils/datetime.util';
import { ConfigService } from '@nestjs/config';
import {
  CreateWebhookDto,
  DeleteWebhookDto,
  GetWebhookDto,
  ListDeliveriesDto,
  ListWebhooksDto,
  UpdateWebhookDto,
} from './dto/create-webhook.dto';
import {
  DEFAULT_RETRY_CONFIG,
  PublicWebhookDefinition,
  WebhookDefinition,
  WebhookFilter,
  WebhookRetryConfig,
  WebhookTransform,
} from './entities/webhook-definition.entity';
import {
  DeliveryStatus,
  WebhookDelivery,
} from './entities/webhook-delivery.entity';
import { WebhookCrypto } from './webhook-crypto';
import { SsrfGuard } from '../common/ssrf-guard';
import { WebhookTransformEngine } from './webhook-transform-engine';

interface WebhookRow {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  active: number;
  auth_type: string;
  auth_secret: string;
  events: string;
  filters: string;
  transform: string;
  retry_config: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  workspace_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  scheduled_at: string;
  sent_at: string | null;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  request_url: string;
  request_body: string;
  response_body: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

const DELIVERIES_TABLE = 'webhook_deliveries';
const DEFINITIONS_TABLE = 'webhook_definitions';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly crypto: WebhookCrypto,
    private readonly ssrf: SsrfGuard,
    private readonly transformEngine: WebhookTransformEngine,
    private readonly config: ConfigService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────

  async create(dto: CreateWebhookDto): Promise<PublicWebhookDefinition> {
    this.ssrf.assertSafeUrl(dto.url, {
      allowHttp: this.httpAllowed(),
      allowPrivate: this.privateAllowed(),
    });
    this.transformEngine.assertCompilable(this.dtoToTransform(dto.transform));

    // Enforce (workspace_id, name) uniqueness in service layer.
    const existing = await this.clickhouse.querySystem<WebhookRow>(
      `SELECT * FROM ${DEFINITIONS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND name = {name:String}
         AND deleted_at IS NULL`,
      { workspace_id: dto.workspace_id, name: dto.name },
    );
    if (existing.length > 0) {
      throw new ConflictException({
        code: 'DUPLICATE_NAME',
        message: `A webhook named "${dto.name}" already exists in this workspace.`,
      });
    }

    const now = toClickHouseDateTime();
    const id = `wh_${generateId().replace(/-/g, '').slice(0, 22)}`;

    const auth = this.resolveAuth(dto.auth);
    const definition: WebhookDefinition = {
      id,
      workspace_id: dto.workspace_id,
      name: dto.name,
      url: dto.url,
      active: dto.active ?? true,
      auth_type: auth.type,
      auth_secret_encrypted:
        auth.token && auth.token.length > 0
          ? this.crypto.encryptSecret(auth.token)
          : '',
      events: dto.events,
      filters: (dto.filters ?? []) as WebhookFilter[],
      transform: this.dtoToTransform(dto.transform),
      retry_config: this.dtoToRetry(dto.retry),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await this.clickhouse.insertSystem(DEFINITIONS_TABLE, [
      this.serialize(definition),
    ]);

    return this.toPublic(definition);
  }

  async get(dto: GetWebhookDto): Promise<PublicWebhookDefinition> {
    const def = await this.findById(dto.workspace_id, dto.id);
    if (!def) {
      throw new NotFoundException({
        code: 'WEBHOOK_NOT_FOUND',
        message: `Webhook ${dto.id} not found.`,
      });
    }
    return this.toPublic(def);
  }

  async list(dto: ListWebhooksDto): Promise<PublicWebhookDefinition[]> {
    const params: Record<string, unknown> = { workspace_id: dto.workspace_id };
    let activeClause = '';
    if (dto.active === true) {
      activeClause = ' AND active = 1';
    } else if (dto.active === false) {
      activeClause = ' AND active = 0';
    }
    const rows = await this.clickhouse.querySystem<WebhookRow>(
      `SELECT * FROM ${DEFINITIONS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND deleted_at IS NULL${activeClause}
       ORDER BY created_at DESC`,
      params,
    );
    return rows.map((row) => this.toPublic(this.parse(row)));
  }

  async update(dto: UpdateWebhookDto): Promise<PublicWebhookDefinition> {
    const existing = await this.findById(dto.workspace_id, dto.id);
    if (!existing) {
      throw new NotFoundException({
        code: 'WEBHOOK_NOT_FOUND',
        message: `Webhook ${dto.id} not found.`,
      });
    }

    if (dto.url !== undefined) {
      this.ssrf.assertSafeUrl(dto.url, {
        allowHttp: this.httpAllowed(),
        allowPrivate: this.privateAllowed(),
      });
    }
    if (dto.transform !== undefined) {
      this.transformEngine.assertCompilable(this.dtoToTransform(dto.transform));
    }

    if (dto.name !== undefined && dto.name !== existing.name) {
      const dup = await this.clickhouse.querySystem<WebhookRow>(
        `SELECT id FROM ${DEFINITIONS_TABLE} FINAL
         WHERE workspace_id = {workspace_id:String}
           AND name = {name:String}
           AND id != {id:String}
           AND deleted_at IS NULL`,
        { workspace_id: dto.workspace_id, name: dto.name, id: dto.id },
      );
      if (dup.length > 0) {
        throw new ConflictException({
          code: 'DUPLICATE_NAME',
          message: `A webhook named "${dto.name}" already exists in this workspace.`,
        });
      }
    }

    // Validate auth.type when supplied (structured 400, not a silent bad value).
    const newAuthType =
      dto.auth !== undefined ? this.resolveAuth(dto.auth).type : existing.auth_type;

    const now = toClickHouseDateTime();
    const updated: WebhookDefinition = {
      ...existing,
      name: dto.name ?? existing.name,
      url: dto.url ?? existing.url,
      active: dto.active ?? existing.active,
      auth_type: newAuthType,
      auth_secret_encrypted:
        dto.auth?.token !== undefined
          ? dto.auth.token.length > 0
            ? this.crypto.encryptSecret(dto.auth.token)
            : ''
          : existing.auth_secret_encrypted,
      events: dto.events ?? existing.events,
      filters: (dto.filters ?? existing.filters) as WebhookFilter[],
      transform:
        dto.transform !== undefined
          ? this.dtoToTransform(dto.transform)
          : existing.transform,
      retry_config:
        dto.retry !== undefined ? this.dtoToRetry(dto.retry) : existing.retry_config,
      updated_at: now,
    };

    await this.clickhouse.insertSystem(DEFINITIONS_TABLE, [
      this.serialize(updated),
    ]);
    return this.toPublic(updated);
  }

  async softDelete(dto: DeleteWebhookDto): Promise<{ success: true }> {
    const existing = await this.findById(dto.workspace_id, dto.id);
    if (!existing) {
      throw new NotFoundException({
        code: 'WEBHOOK_NOT_FOUND',
        message: `Webhook ${dto.id} not found.`,
      });
    }
    const now = toClickHouseDateTime();
    const tombstoned: WebhookDefinition = {
      ...existing,
      active: false,
      deleted_at: now,
      updated_at: now,
    };
    await this.clickhouse.insertSystem(DEFINITIONS_TABLE, [
      this.serialize(tombstoned),
    ]);
    return { success: true };
  }

  // ─── Internal lookups used by dispatcher / worker ─────────────────

  async findById(workspaceId: string, id: string): Promise<WebhookDefinition | null> {
    const rows = await this.clickhouse.querySystem<WebhookRow>(
      `SELECT * FROM ${DEFINITIONS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND id = {id:String}
         AND deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: workspaceId, id },
    );
    return rows.length > 0 ? this.parse(rows[0]) : null;
  }

  /** Internal lookup by id only (cross-workspace) — used by worker. */
  async findByIdInternal(id: string): Promise<WebhookDefinition | null> {
    const rows = await this.clickhouse.querySystem<WebhookRow>(
      `SELECT * FROM ${DEFINITIONS_TABLE} FINAL
       WHERE id = {id:String}
         AND deleted_at IS NULL
       LIMIT 1`,
      { id },
    );
    return rows.length > 0 ? this.parse(rows[0]) : null;
  }

  async findActive(workspaceId: string): Promise<WebhookDefinition[]> {
    const rows = await this.clickhouse.querySystem<WebhookRow>(
      `SELECT * FROM ${DEFINITIONS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND deleted_at IS NULL
         AND active = 1`,
      { workspace_id: workspaceId },
    );
    return rows.map((row) => this.parse(row));
  }

  /** Decrypt the auth secret. Returns '' when no secret stored. */
  decryptSecret(webhook: WebhookDefinition): string {
    if (!webhook.auth_secret_encrypted) return '';
    return this.crypto.decryptSecret(webhook.auth_secret_encrypted);
  }

  // ─── Deliveries persistence ──────────────────────────────────────

  async enqueueDelivery(
    webhook: WebhookDefinition,
    event: { event_id: string; event_type: string; payload: Record<string, unknown> },
  ): Promise<WebhookDelivery> {
    const now = toClickHouseDateTime();
    const delivery: WebhookDelivery = {
      id: `del_${generateId().replace(/-/g, '').slice(0, 22)}`,
      webhook_id: webhook.id,
      workspace_id: webhook.workspace_id,
      event_id: event.event_id,
      event_type: event.event_type,
      attempt: 1,
      scheduled_at: now,
      sent_at: null,
      status: 'pending',
      http_status: null,
      latency_ms: null,
      request_url: webhook.url,
      request_body: this.truncate(JSON.stringify(event.payload)),
      response_body: '',
      error_message: '',
      created_at: now,
      updated_at: now,
    };
    await this.clickhouse.insertSystem(DELIVERIES_TABLE, [
      this.serializeDelivery(delivery),
    ]);
    return delivery;
  }

  async findReadyDeliveries(limit = 50): Promise<WebhookDelivery[]> {
    const rows = await this.clickhouse.querySystem<DeliveryRow>(
      `SELECT * FROM ${DELIVERIES_TABLE} FINAL
       WHERE status IN ('pending', 'retrying')
         AND scheduled_at <= now64(3)
       ORDER BY scheduled_at ASC
       LIMIT {lim:UInt32}`,
      { lim: limit },
    );
    return rows.map((row) => this.parseDelivery(row));
  }

  async updateDelivery(delivery: WebhookDelivery): Promise<void> {
    const now = toClickHouseDateTime();
    const updated: WebhookDelivery = { ...delivery, updated_at: now };
    await this.clickhouse.insertSystem(DELIVERIES_TABLE, [
      this.serializeDelivery(updated),
    ]);
  }

  async listDeliveries(dto: ListDeliveriesDto): Promise<WebhookDelivery[]> {
    const params: Record<string, unknown> = { workspace_id: dto.workspace_id };
    const clauses: string[] = ['workspace_id = {workspace_id:String}'];
    if (dto.webhook_id) {
      params.webhook_id = dto.webhook_id;
      clauses.push('webhook_id = {webhook_id:String}');
    }
    if (dto.status) {
      params.status = dto.status;
      clauses.push('status = {status:String}');
    }
    params.lim = Math.min(Math.max(dto.limit ?? 50, 1), 500);
    const rows = await this.clickhouse.querySystem<DeliveryRow>(
      `SELECT * FROM ${DELIVERIES_TABLE} FINAL
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT {lim:UInt32}`,
      params,
    );
    return rows.map((row) => this.parseDelivery(row));
  }

  async getDelivery(workspaceId: string, id: string): Promise<WebhookDelivery | null> {
    const rows = await this.clickhouse.querySystem<DeliveryRow>(
      `SELECT * FROM ${DELIVERIES_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND id = {id:String}
       LIMIT 1`,
      { workspace_id: workspaceId, id },
    );
    return rows.length > 0 ? this.parseDelivery(rows[0]) : null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private httpAllowed(): boolean {
    return this.config.get<string>('WEBHOOK_ALLOW_HTTP') === 'true';
  }

  private privateAllowed(): boolean {
    return this.config.get<string>('WEBHOOK_ALLOW_PRIVATE_IPS') === 'true';
  }

  toPublic(def: WebhookDefinition): PublicWebhookDefinition {
    // Intentionally drop the encrypted secret.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { auth_secret_encrypted, ...rest } = def;
    return {
      ...rest,
      auth: {
        type: def.auth_type,
        has_secret: def.auth_secret_encrypted.length > 0,
      },
    };
  }

  /**
   * Normalize the optional auth block. Omitting `auth` defaults to
   * { type: 'none' } (public endpoint, no credentials) instead of crashing on
   * `dto.auth.type` (was a 500 — cf task #6). A present-but-invalid type yields
   * a structured 400 so IA callers can react.
   */
  private resolveAuth(
    auth?: { type?: string; token?: string },
  ): { type: WebhookDefinition['auth_type']; token?: string } {
    if (!auth || auth.type === undefined) return { type: 'none' };
    const valid: WebhookDefinition['auth_type'][] = ['none', 'bearer', 'basic', 'hmac'];
    if (!valid.includes(auth.type as WebhookDefinition['auth_type'])) {
      throw new BadRequestException({
        code: 'INVALID_AUTH',
        message: `auth.type must be one of ${valid.join(', ')}`,
      });
    }
    return { type: auth.type as WebhookDefinition['auth_type'], token: auth.token };
  }

  private dtoToTransform(
    transform?: {
      type: 'passthrough' | 'template' | 'twenty';
      template?: string;
      dry_run?: boolean;
    },
  ): WebhookTransform {
    if (!transform) return null;
    if (transform.type === 'passthrough') return { type: 'passthrough' };
    if (transform.type === 'twenty') {
      return { type: 'twenty', dry_run: transform.dry_run === true };
    }
    if (transform.type === 'template') {
      if (!transform.template) {
        throw new BadRequestException({
          code: 'INVALID_TRANSFORM',
          message: 'transform.template is required when transform.type=template',
        });
      }
      return { type: 'template', template: transform.template };
    }
    return null;
  }

  private dtoToRetry(retry?: WebhookRetryConfig): WebhookRetryConfig {
    if (!retry) return DEFAULT_RETRY_CONFIG;
    if (
      retry.max_attempts < 1 ||
      retry.max_attempts > 10 ||
      retry.backoff_ms.length === 0
    ) {
      throw new BadRequestException({
        code: 'INVALID_RETRY',
        message:
          'retry.max_attempts must be between 1 and 10 and backoff_ms must be a non-empty array.',
      });
    }
    return retry;
  }

  private truncate(text: string, limit = 64_000): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + '… [truncated]';
  }

  private serialize(def: WebhookDefinition): Record<string, unknown> {
    return {
      id: def.id,
      workspace_id: def.workspace_id,
      name: def.name,
      url: def.url,
      active: def.active ? 1 : 0,
      auth_type: def.auth_type,
      auth_secret: def.auth_secret_encrypted,
      events: JSON.stringify(def.events),
      filters: JSON.stringify(def.filters),
      transform: def.transform ? JSON.stringify(def.transform) : '',
      retry_config: JSON.stringify(def.retry_config),
      created_at: def.created_at,
      updated_at: def.updated_at,
      deleted_at: def.deleted_at,
    };
  }

  private parse(row: WebhookRow): WebhookDefinition {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      name: row.name,
      url: row.url,
      active: row.active === 1,
      auth_type: row.auth_type as WebhookDefinition['auth_type'],
      auth_secret_encrypted: row.auth_secret ?? '',
      events: this.safeJsonArray(row.events, []),
      filters: this.safeJsonArray(row.filters, []) as WebhookFilter[],
      transform: row.transform ? this.safeJsonObject(row.transform, null) : null,
      retry_config: this.safeJsonObject(row.retry_config, DEFAULT_RETRY_CONFIG),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  }

  private serializeDelivery(delivery: WebhookDelivery): Record<string, unknown> {
    return {
      id: delivery.id,
      webhook_id: delivery.webhook_id,
      workspace_id: delivery.workspace_id,
      event_id: delivery.event_id,
      event_type: delivery.event_type,
      attempt: delivery.attempt,
      scheduled_at: delivery.scheduled_at,
      sent_at: delivery.sent_at,
      status: delivery.status,
      http_status: delivery.http_status,
      latency_ms: delivery.latency_ms,
      request_url: delivery.request_url,
      request_body: delivery.request_body,
      response_body: delivery.response_body,
      error_message: delivery.error_message,
      created_at: delivery.created_at,
      updated_at: delivery.updated_at,
    };
  }

  private parseDelivery(row: DeliveryRow): WebhookDelivery {
    return {
      id: row.id,
      webhook_id: row.webhook_id,
      workspace_id: row.workspace_id,
      event_id: row.event_id,
      event_type: row.event_type,
      attempt: row.attempt,
      scheduled_at: row.scheduled_at,
      sent_at: row.sent_at,
      status: row.status as DeliveryStatus,
      http_status: row.http_status,
      latency_ms: row.latency_ms,
      request_url: row.request_url,
      request_body: row.request_body,
      response_body: row.response_body,
      error_message: row.error_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private safeJsonArray<T>(value: string, fallback: T[]): T[] {
    if (!value) return fallback;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : fallback;
    } catch {
      this.logger.warn(`Failed to parse JSON array: ${value.slice(0, 64)}`);
      return fallback;
    }
  }

  private safeJsonObject<T>(value: string, fallback: T): T {
    if (!value) return fallback;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
    } catch {
      this.logger.warn(`Failed to parse JSON object: ${value.slice(0, 64)}`);
      return fallback;
    }
  }
}
