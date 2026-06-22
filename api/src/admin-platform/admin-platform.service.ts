import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { ClickHouseService } from '../database/clickhouse.service';
import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { MailService } from '../mail/mail.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AnalyticsQueryDto } from '../analytics/dto/analytics-query.dto';
import { VoipService } from '../voip/voip.service';
import { VoipSyncService } from '../voip/voip-sync.service';
import type { PhoneSource } from '../voip/voip.types';
import { GscService } from '../gsc/gsc.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookDeliveryWorker } from '../webhooks/webhook-delivery-worker.service';
import {
  CreateWebhookDto,
  DeleteWebhookDto,
  ListWebhooksDto,
  TestWebhookDto,
} from '../webhooks/dto/create-webhook.dto';
import { generateId, generateToken } from '../common/crypto';
import { toClickHouseDateTime } from '../common/utils/datetime.util';
import {
  ProvisionTenantDto,
  PhoneNumberDto,
} from './dto/provision-tenant.dto';
import {
  PhoneNumberProvisionStatus,
  ProvisionTenantResponseDto,
} from './dto/provision-tenant-response.dto';
import {
  VoipAddPhoneNumberDto,
  VoipCredentialKindDto,
  VoipSaveCredentialDto,
} from './dto/voip-admin.dto';
import { UpdateWorkspaceSettingsM2MDto } from './dto/update-workspace-settings.dto';
import { WorkspaceStatusResponseDto } from './dto/workspace-status-response.dto';
import { AdsConversionsDto } from './dto/ads-conversions.dto';
import {
  AdsClickIdSource,
  AdsConversionsResponseDto,
} from './dto/ads-conversions-response.dto';

const PASSWORD_RESET_EXPIRY_HOURS = 24;
const MAX_SLUG_COLLISION_ATTEMPTS = 50;

/** Google Ads click-id types carried in `utm_id_from`. */
const ADS_CLICK_ID_TYPES = ['gclid', 'gbraid', 'wbraid'] as const;
/** Default look-back window for ads.conversions when no range is supplied. */
const ADS_DEFAULT_LOOKBACK_DAYS = 28;
/** Default / hard cap on returned conversion rows. */
const ADS_DEFAULT_LIMIT = 1000;
const ADS_MAX_LIMIT = 10000;

@Injectable()
export class AdminPlatformService {
  private readonly logger = new Logger(AdminPlatformService.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly usersService: UsersService,
    private readonly workspacesService: WorkspacesService,
    private readonly apiKeysService: ApiKeysService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly analyticsService: AnalyticsService,
    private readonly voipService: VoipService,
    private readonly voipSyncService: VoipSyncService,
    private readonly gscService: GscService,
    private readonly webhooksService: WebhooksService,
    private readonly webhookDeliveryWorker: WebhookDeliveryWorker,
  ) {}

  /**
   * Provision a brand-new tenant in one call (M2M endpoint).
   *
   * Sequence (compensation-on-fail, since ClickHouse has no transactions):
   *   1. Pre-check: email must not already exist  → 409 if it does (V1).
   *   2. Slugify name → workspace_id (collision-resolving suffix).
   *   3. Create owner user (random 32-char password, magic-link reset
   *      will be sent so user never knows it).
   *   4. Create workspace (sets owner via WorkspacesService.create).
   *   5. Create workspace-scoped admin API key.
   *   6. (Optional) forward phone numbers to bridge if configured.
   *   7. Issue password_reset_token + send password reset email.
   *
   * If steps 4/5 fail, we soft-delete the user created in step 3 to
   * keep the email re-usable.
   */
  async provisionTenant(
    dto: ProvisionTenantDto,
  ): Promise<ProvisionTenantResponseDto> {
    const email = dto.email.toLowerCase();

    // 1. Email uniqueness pre-check.
    // NOTE V1: we deliberately refuse duplicates (409). The "attach a new
    // workspace to an existing user" flow is left for a follow-up sprint
    // (cf TODO in ticket). Returning 409 keeps the contract simple.
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      throw new ConflictException({
        error: 'email_already_exists',
        message:
          'A user already exists with this email. Reuse-existing-user flow is not implemented yet (V1).',
      });
    }

    // 2. Resolve workspace_id: explicit (D2 migration adopting a legacy id)
    //    or slugified from name with collision resolution (default flow).
    const workspaceId = dto.workspace_id
      ? await this.useExplicitWorkspaceId(dto.workspace_id)
      : await this.findFreeWorkspaceId(dto.name);

    // 3. Create owner user.
    const randomPassword = randomBytes(24).toString('base64url');
    let createdUserId: string | undefined;
    try {
      const user = await this.usersService.create({
        email,
        name: this.deriveUserName(dto.name, email),
        password: randomPassword,
      });
      createdUserId = user.id;
    } catch (err) {
      // UsersService.create throws ConflictException if email exists (race
      // between the pre-check and the insert). Surface it cleanly.
      this.logger.error(
        `[provision] user creation failed for ${email}: ${(err as Error).message}`,
      );
      throw err;
    }

    // 4 + 5. Workspace + API key.
    let apiKeyValue: string;
    try {
      await this.workspacesService.create(
        {
          id: workspaceId,
          name: dto.name,
          website: dto.siteUrl,
          timezone: dto.timezone ?? 'Europe/Paris',
          currency: dto.currency ?? 'EUR',
        },
        {
          id: createdUserId!,
          email,
          name: this.deriveUserName(dto.name, email),
          isSuperAdmin: true, // platform-admin acts as super_admin for create
        },
      );

      const keyResult = await this.apiKeysService.create(
        {
          workspace_id: workspaceId,
          user_id: createdUserId!,
          name: 'Veridian platform key',
          description:
            'Auto-provisioned via /api/admin/platform/tenants.provision. Used by tracker SDK + Hub bridge.',
          role: 'admin',
        },
        createdUserId!,
      );
      apiKeyValue = keyResult.key;
    } catch (err) {
      // Compensation: soft-delete the user so the email is freed.
      this.logger.error(
        `[provision] workspace/apikey creation failed for ${email} / ${workspaceId}: ${(err as Error).message}`,
      );
      if (createdUserId) {
        await this.softDeleteUserSilently(createdUserId);
      }
      throw new InternalServerErrorException({
        error: 'provisioning_failed',
        message:
          'Workspace or API key creation failed; user rolled back. Retry safe.',
        cause: (err as Error).message,
      });
    }

    // 6. Phone numbers (best-effort, never aborts provisioning).
    const phoneStatus = await this.forwardPhoneNumbersToBridge(
      workspaceId,
      dto.phoneNumbers,
    );

    // 7. Magic-link password reset email.
    const passwordResetUrl = await this.createPasswordResetAndEmail(
      createdUserId!,
      email,
      this.deriveUserName(dto.name, email),
    );

    // Build response.
    const snippetHtml = this.buildTrackerSnippet(workspaceId);
    const dashboardUrl = `${this.appUrl()}/workspaces/${workspaceId}`;

    return {
      workspace_id: workspaceId,
      owner_user_id: createdUserId!,
      api_key: apiKeyValue,
      snippet_html: snippetHtml,
      dashboard_url: dashboardUrl,
      password_reset_url: passwordResetUrl,
      phone_numbers: phoneStatus,
      user_created: true,
    };
  }

  /**
   * Provision a workspace-scoped API key for an EXISTING (platform-managed)
   * workspace (M2M, task #8). The tunnel workspace vrd_veridian_site_staging
   * has no members, so the normal apiKeys.create (WorkspaceAuthGuard + member)
   * cannot bootstrap a first key — this M2M path does it behind
   * PlatformAdminGuard. Returns the key ONCE (never re-logged).
   */
  async provisionApiKey(params: {
    workspace_id: string;
    name?: string;
    role?: 'admin' | 'editor' | 'viewer';
  }): Promise<{ workspace_id: string; api_key: string; key_prefix: string }> {
    if (!(await this.workspaceExists(params.workspace_id))) {
      throw new NotFoundException({
        error: 'workspace_not_found',
        message: `Workspace ${params.workspace_id} does not exist.`,
      });
    }
    const result = await this.apiKeysService.createForPlatform({
      workspace_id: params.workspace_id,
      name: params.name,
      role: params.role,
    });
    return {
      workspace_id: params.workspace_id,
      api_key: result.key,
      key_prefix: result.apiKey.key_prefix,
    };
  }

  /**
   * Revoke a workspace-scoped API key for a platform-managed workspace (M2M).
   * Symmetric of provisionApiKey. The key is identified by key_id OR
   * key_prefix (the latter is the only handle provisionApiKey returns).
   *
   * Delegates the ownership check + revocation to
   * ApiKeysService.revokeForPlatform (no @JwtOnly path) — a platform-managed
   * workspace has no member, so the JWT-only apiKeys.revoke is unreachable.
   * Idempotent: revoking an already-revoked key is a no-op success.
   */
  async revokeApiKey(params: {
    workspace_id: string;
    key_id?: string;
    key_prefix?: string;
  }): Promise<{
    workspace_id: string;
    key_id: string;
    key_prefix: string;
    status: string;
    revoked_at: string | null;
  }> {
    if (!(await this.workspaceExists(params.workspace_id))) {
      throw new NotFoundException({
        error: 'workspace_not_found',
        message: `Workspace ${params.workspace_id} does not exist.`,
      });
    }
    const revoked = await this.apiKeysService.revokeForPlatform({
      workspace_id: params.workspace_id,
      key_id: params.key_id,
      key_prefix: params.key_prefix,
    });
    return {
      workspace_id: params.workspace_id,
      key_id: revoked.id,
      key_prefix: revoked.key_prefix,
      status: revoked.status,
      revoked_at: revoked.revoked_at,
    };
  }

  /**
   * List the API keys of a platform-managed workspace for audit (M2M).
   * Returns public keys (no key_hash, no plaintext) — only metadata.
   */
  async listApiKeys(params: {
    workspace_id: string;
    status?: 'active' | 'revoked' | 'expired';
  }) {
    if (!(await this.workspaceExists(params.workspace_id))) {
      throw new NotFoundException({
        error: 'workspace_not_found',
        message: `Workspace ${params.workspace_id} does not exist.`,
      });
    }
    const keys = await this.apiKeysService.listForPlatform(
      params.workspace_id,
      params.status,
    );
    return { workspace_id: params.workspace_id, api_keys: keys };
  }

  /**
   * Run an analytics query on behalf of the platform (M2M).
   *
   * The normal `POST /api/analytics.query` is gated by `WorkspaceAuthGuard`
   * (workspace-scoped API key OR member JWT). The bridge has neither — it
   * used to authenticate with a hidden super_admin login (`getAdminToken`).
   * This M2M path lets the bridge read any workspace's analytics behind the
   * single shared `PLATFORM_ADMIN_API_KEY` (PlatformAdminGuard) instead.
   *
   * We delegate straight to `AnalyticsService.query()`: it owns metric/table
   * validation, workspace existence check and caching. No auth logic here —
   * that is the guard's job. The DTO is the canonical native
   * `AnalyticsQueryDto` (preset date ranges, per-table metrics) — callers
   * must speak the native contract, not the legacy Staminads `{type}` shape.
   */
  async analyticsQuery(dto: AnalyticsQueryDto) {
    return this.analyticsService.query(dto);
  }

  // ---------------------------------------------------------------------------
  // Lot A — Consolidated workspace status (M2M)
  // ---------------------------------------------------------------------------

  /**
   * One-call, IA-readable snapshot of a workspace: existence, tracking
   * liveness, and every connector's state (GSC / VoIP / webhooks) + the
   * ready-to-paste tracker snippet.
   *
   * Pure composition over existing services — no new query/persistence logic.
   * Each connector probe is best-effort: a failing sub-probe degrades to a
   * safe default (e.g. tracking.active=false) rather than failing the whole
   * status call, so an IA always gets an actionable answer.
   */
  async getConsolidatedStatus(
    workspaceId: string,
  ): Promise<WorkspaceStatusResponseDto> {
    if (!(await this.workspaceExists(workspaceId))) {
      return {
        workspace_id: workspaceId,
        exists: false,
        name: null,
        status: null,
        tracking: null,
        gsc: null,
        voip: null,
        webhooks: null,
        snippet_html: null,
      };
    }

    const [workspace, tracking, gsc, voip, webhooks] = await Promise.all([
      this.workspacesService.get(workspaceId).catch(() => null),
      this.probeTracking(workspaceId),
      this.probeGsc(workspaceId),
      this.probeVoip(workspaceId),
      this.probeWebhooks(workspaceId),
    ]);

    return {
      workspace_id: workspaceId,
      exists: true,
      name: workspace?.name ?? null,
      status: workspace?.status ?? null,
      tracking,
      gsc,
      voip,
      webhooks,
      snippet_html: this.buildTrackerSnippet(workspaceId),
    };
  }

  /**
   * Tracking liveness via two analytics session counts (30d window + 30min
   * live). We use the `sessions` metric (`count()`) on the `sessions` table —
   * the most robust signal, immune to the pageviews `countIf(name=…)` quirk.
   */
  private async probeTracking(workspaceId: string): Promise<{
    active: boolean;
    sessions_30d: number;
    live: boolean;
  }> {
    const safe = { active: false, sessions_30d: 0, live: false };
    try {
      const [last30d, last30min] = await Promise.all([
        this.countSessions(workspaceId, 'previous_30_days'),
        this.countSessions(workspaceId, 'previous_30_minutes'),
      ]);
      return {
        active: last30d > 0,
        sessions_30d: last30d,
        live: last30min > 0,
      };
    } catch (err) {
      this.logger.warn(
        `[status] tracking probe failed for ${workspaceId}: ${(err as Error).message}`,
      );
      return safe;
    }
  }

  private async countSessions(
    workspaceId: string,
    preset: 'previous_30_days' | 'previous_30_minutes',
  ): Promise<number> {
    const res = await this.analyticsService.query({
      workspace_id: workspaceId,
      metrics: ['sessions'],
      table: 'sessions',
      dateRange: { preset },
    } as AnalyticsQueryDto);
    const rows = Array.isArray(res.data) ? res.data : [];
    const first = rows[0] as Record<string, unknown> | undefined;
    const raw = first?.sessions;
    const n = typeof raw === 'number' ? raw : Number(raw ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private async probeGsc(workspaceId: string): Promise<{
    connected: boolean;
    site_url: string | null;
    ownership_state: string | null;
    last_sync_at: string | null;
  }> {
    try {
      const s = await this.gscService.status(workspaceId);
      return {
        connected: s.connected,
        site_url: s.site_url ?? null,
        ownership_state: s.ownership_state ?? null,
        last_sync_at: s.last_sync_at ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `[status] gsc probe failed for ${workspaceId}: ${(err as Error).message}`,
      );
      return {
        connected: false,
        site_url: null,
        ownership_state: null,
        last_sync_at: null,
      };
    }
  }

  private async probeVoip(workspaceId: string): Promise<{
    configured: boolean;
    phone_number_count: number;
    phone_numbers: Array<{
      e164: string;
      source: PhoneSource;
      label: string | null;
    }>;
    last_sync_at: string | null;
    credential_kinds: string[];
  }> {
    try {
      const [creds, numbers] = await Promise.all([
        this.voipService.listCredentials(workspaceId),
        this.voipService.listPhoneNumbers(workspaceId),
      ]);
      // Most recent successful sync across configured credentials.
      const lastSync = creds
        .map((c) => c.lastSyncAt)
        .filter((d): d is string => !!d)
        .sort()
        .pop();
      return {
        configured: creds.length > 0,
        phone_number_count: numbers.phoneNumbers.length,
        phone_numbers: numbers.phoneNumbers.map((n) => ({
          e164: n.e164,
          source: n.source,
          label: n.label,
        })),
        last_sync_at: lastSync ?? null,
        credential_kinds: creds.map((c) => c.kind),
      };
    } catch (err) {
      this.logger.warn(
        `[status] voip probe failed for ${workspaceId}: ${(err as Error).message}`,
      );
      return {
        configured: false,
        phone_number_count: 0,
        phone_numbers: [],
        last_sync_at: null,
        credential_kinds: [],
      };
    }
  }

  private async probeWebhooks(workspaceId: string): Promise<{
    active_count: number;
    webhooks: Array<{ id: string; name: string; url: string; active: boolean }>;
  }> {
    try {
      const list = await this.webhooksService.list({
        workspace_id: workspaceId,
        active: true,
      });
      return {
        active_count: list.length,
        webhooks: list.map((w) => ({
          id: w.id,
          name: w.name,
          url: w.url,
          active: w.active,
        })),
      };
    } catch (err) {
      this.logger.warn(
        `[status] webhooks probe failed for ${workspaceId}: ${(err as Error).message}`,
      );
      return { active_count: 0, webhooks: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Lot B — VoIP M2M (delegates to VoipService / VoipSyncService)
  // ---------------------------------------------------------------------------

  /** List a workspace's tracked phone numbers + allowed sources (M2M). */
  async voipListPhoneNumbers(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    return this.voipService.listPhoneNumbers(workspaceId);
  }

  /** Map a phone number to a traffic source for a workspace (M2M). */
  async voipAddPhoneNumber(dto: VoipAddPhoneNumberDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    const phoneNumber = await this.voipService.createPhoneNumber(
      dto.workspace_id,
      dto.e164,
      dto.source,
      dto.label ?? null,
    );
    return { ok: true as const, phoneNumber };
  }

  /** Soft-delete a tracked phone number by id (M2M). */
  async voipRemovePhoneNumber(workspaceId: string, id: string) {
    await this.assertWorkspaceExists(workspaceId);
    return this.voipService.deletePhoneNumber(workspaceId, id);
  }

  /**
   * List a workspace's VoIP credentials (masked — secrets never returned).
   */
  async voipListCredentials(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    return { credentials: await this.voipService.listCredentials(workspaceId) };
  }

  /**
   * Register/replace a VoIP credential (M2M). `creds` is write-only: it is
   * encrypted at rest by VoipService and the masked credential is returned —
   * the raw secret is never echoed back.
   */
  async voipSaveCredential(dto: VoipSaveCredentialDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    const credential = await this.voipService.saveCredential(
      dto.workspace_id,
      dto.kind,
      dto.creds,
    );
    return { ok: true as const, credential };
  }

  /** Test a VoIP credential against the provider API (M2M). */
  async voipTestCredential(dto: VoipCredentialKindDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    const result = await this.voipService.testCredential(
      dto.workspace_id,
      dto.kind,
    );
    return { ok: result.ok, message: result.message, status: result.status };
  }

  /** Soft-delete a VoIP credential (M2M). */
  async voipDeleteCredential(dto: VoipCredentialKindDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    return this.voipService.deleteCredential(dto.workspace_id, dto.kind);
  }

  /**
   * Trigger an immediate VoIP sync (M2M).
   *
   * NOTE: like the workspace-scoped voip.sync, the underlying syncAll() runs
   * across ALL active credentials (the cron is global). We still require a
   * valid `workspace_id` so the M2M contract is scoped/auditable and an IA
   * cannot fire a global sync without naming a tenant it manages.
   */
  async voipSync(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    const result = await this.voipSyncService.syncAll();
    return { ok: true as const, ...result };
  }

  // ---------------------------------------------------------------------------
  // Lot C — GSC M2M (status + resync only; OAuth stays human/browser)
  // ---------------------------------------------------------------------------

  /** Read the GSC connection state of a workspace (M2M). No tokens exposed. */
  async gscStatus(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    return this.gscService.status(workspaceId);
  }

  /** Trigger an immediate GSC sync for a connected workspace (M2M). */
  async gscResync(workspaceId: string, days?: number) {
    await this.assertWorkspaceExists(workspaceId);
    return this.gscService.resync(workspaceId, days ?? 30);
  }

  // ---------------------------------------------------------------------------
  // Lot D — Webhooks / Twenty connectors M2M (delegates to WebhooksService)
  // ---------------------------------------------------------------------------

  /** List webhook destinations for a workspace (M2M). Secrets never returned. */
  async webhooksList(dto: ListWebhooksDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    return this.webhooksService.list(dto);
  }

  /**
   * Create a webhook destination (M2M). SSRF protection is enforced by
   * WebhooksService.create (it calls SsrfGuard.assertSafeUrl) — we do NOT
   * re-implement it here. The auth secret is write-only (toPublic drops it).
   */
  async webhooksCreate(dto: CreateWebhookDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    return this.webhooksService.create(dto);
  }

  /** Soft-delete a webhook destination (M2M). */
  async webhooksDelete(dto: DeleteWebhookDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    return this.webhooksService.softDelete(dto);
  }

  /**
   * Synchronous test delivery to a webhook destination (M2M).
   *
   * Mirrors WebhooksController.test: enqueue a (synthetic or supplied) event,
   * send it once via the delivery worker, persist the outcome, return it
   * inline. The destination URL was SSRF-checked at create/update time.
   */
  async webhooksTest(dto: TestWebhookDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    const webhook = await this.webhooksService.findById(
      dto.workspace_id,
      dto.id,
    );
    if (!webhook) {
      throw new NotFoundException({
        code: 'WEBHOOK_NOT_FOUND',
        message: `Webhook ${dto.id} not found.`,
      });
    }
    const synthetic =
      dto.event ?? {
        event_type: 'webhook.test',
        event_id: `test_${Date.now()}`,
        workspace_id: dto.workspace_id,
        path: '/__test__',
        utm: { source: 'webhook-test' },
      };
    const delivery = await this.webhooksService.enqueueDelivery(webhook, {
      event_id: String(synthetic.event_id ?? `test_${Date.now()}`),
      event_type: String(synthetic.event_type ?? 'webhook.test'),
      payload: synthetic,
    });
    const result = await this.webhookDeliveryWorker.sendOne(webhook, delivery);
    await this.webhooksService.updateDelivery({
      ...delivery,
      status: result.success ? 'success' : 'failed',
      sent_at: toClickHouseDateTime(),
      http_status: result.http_status,
      latency_ms: result.latency_ms,
      response_body: result.response_body,
      error_message: result.error_message,
    });
    return {
      delivery_id: delivery.id,
      success: result.success,
      http_status: result.http_status,
      latency_ms: result.latency_ms,
      response_body: result.response_body,
      error_message: result.error_message,
    };
  }

  // ---------------------------------------------------------------------------
  // Lot E — Workspace settings M2M
  // ---------------------------------------------------------------------------

  /**
   * Update a workspace's settings (M2M). Keyed on `workspace_id` per the M2M
   * convention, mapped onto WorkspacesService.update's `id`-keyed DTO. Deep
   * settings validation (annotations, smtp, geo, filters) is the canonical
   * UpdateWorkspaceSettingsDto — identical to the console path.
   */
  async updateWorkspaceSettings(dto: UpdateWorkspaceSettingsM2MDto) {
    await this.assertWorkspaceExists(dto.workspace_id);
    return this.workspacesService.update({
      id: dto.workspace_id,
      status: dto.status,
      name: dto.name,
      website: dto.website,
      timezone: dto.timezone,
      currency: dto.currency,
      logo_url: dto.logo_url,
      settings: dto.settings,
    });
  }

  // ---------------------------------------------------------------------------
  // Lot F — ads.conversions (READ-only Ads-attributed conversions)
  // ---------------------------------------------------------------------------

  /**
   * Return a workspace's conversions attributed to Google Ads, so an IA / the
   * platform google-ads skill can read them and upload them to the Ads API.
   *
   * READ-only — no Ads credentials, no OAuth, no upload here (that stays in the
   * skill). Pure analytics read over ClickHouse `events`.
   *
   * A conversion is a goal event (`name='goal'`, `goal_name != ''`) that is
   * either:
   *   - web-attributed: its session carries a Google Ads click id
   *     (`utm_id_from IN ('gclid','gbraid','wbraid')`) → `click_id = utm_id`;
   *   - phone-attributed: a `phone_call` goal whose tracked number maps to the
   *     `ads` source (`properties['source']='ads'`) → no click id.
   *
   * Bounded by a date range (default last 28 days) and a row cap (default 1000,
   * hard cap 10000) so we never dump millions of rows. `truncated` signals the
   * cap was hit. Parameterized query (no string interpolation) — injection-safe.
   */
  async getAdsConversions(
    dto: AdsConversionsDto,
  ): Promise<AdsConversionsResponseDto> {
    await this.assertWorkspaceExists(dto.workspace_id);

    const now = new Date();
    const to = dto.to ? new Date(dto.to) : now;
    const from = dto.from
      ? new Date(dto.from)
      : new Date(to.getTime() - ADS_DEFAULT_LOOKBACK_DAYS * 86_400_000);
    const limit = Math.min(dto.limit ?? ADS_DEFAULT_LIMIT, ADS_MAX_LIMIT);

    const fromCh = toClickHouseDateTime(from);
    const toCh = toClickHouseDateTime(to);

    // One row cap covers both branches; +1 to detect truncation.
    const rows = await this.clickhouse.queryWorkspace<{
      click_id_source: string;
      click_id: string;
      conversion_type: string;
      timestamp: string;
      value: number;
      user_id: string | null;
      path: string;
      phone_number: string;
    }>(
      dto.workspace_id,
      `SELECT
         multiIf(
           goal_name = 'phone_call' AND properties['source'] = 'ads', 'phone_source_ads',
           utm_id_from
         ) AS click_id_source,
         if(utm_id_from IN ({clickTypes:Array(String)}), utm_id, '') AS click_id,
         goal_name AS conversion_type,
         toString(coalesce(goal_timestamp, received_at)) AS timestamp,
         toFloat64(goal_value) AS value,
         user_id,
         path,
         properties['to_number'] AS phone_number
       FROM events
       WHERE name = 'goal'
         AND goal_name != ''
         AND received_at >= {from:DateTime64(3)}
         AND received_at <= {to:DateTime64(3)}
         AND (
           utm_id_from IN ({clickTypes:Array(String)})
           OR (goal_name = 'phone_call' AND properties['source'] = 'ads')
         )
       ORDER BY received_at DESC
       LIMIT {lim:UInt32}`,
      {
        clickTypes: [...ADS_CLICK_ID_TYPES],
        from: fromCh,
        to: toCh,
        lim: limit + 1,
      },
    );

    const truncated = rows.length > limit;
    const conversions = rows.slice(0, limit).map((r) => ({
      click_id_source: r.click_id_source as AdsClickIdSource,
      click_id: r.click_id ? r.click_id : null,
      conversion_type: r.conversion_type,
      timestamp: r.timestamp,
      value: typeof r.value === 'number' ? r.value : Number(r.value ?? 0),
      user_id: r.user_id ?? null,
      path: r.path,
      phone_number:
        r.click_id_source === 'phone_source_ads'
          ? r.phone_number || null
          : null,
    }));

    return {
      workspace_id: dto.workspace_id,
      from: from.toISOString(),
      to: to.toISOString(),
      limit,
      count: conversions.length,
      truncated,
      conversions,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Throw a structured 404 if the workspace does not exist. */
  private async assertWorkspaceExists(workspaceId: string): Promise<void> {
    if (!(await this.workspaceExists(workspaceId))) {
      throw new NotFoundException({
        error: 'workspace_not_found',
        message: `Workspace ${workspaceId} does not exist.`,
      });
    }
  }

  /**
   * Slugify a workspace name to match
   *   /^[a-z][a-z0-9_]*$/  (length 2..50)
   * — the schema enforced by CreateWorkspaceDto. Resolves collisions by
   * appending `_2`, `_3`, … up to MAX_SLUG_COLLISION_ATTEMPTS.
   */
  private async findFreeWorkspaceId(name: string): Promise<string> {
    let base = name
      .toLowerCase()
      .normalize('NFD')
      // Strip accents.
      .replace(/[̀-ͯ]/g, '')
      // Replace any non-allowed char with underscore.
      .replace(/[^a-z0-9]+/g, '_')
      // Trim leading/trailing underscores.
      .replace(/^_+|_+$/g, '');

    // Must start with a letter (regex anchors on `[a-z]`).
    if (!/^[a-z]/.test(base)) {
      base = `ws_${base}`;
    }
    // Length bounds: cap at 50, pad to 2.
    base = base.substring(0, 47); // leave room for `_NN` suffix
    if (base.length < 2) {
      base = `${base}_x`;
    }

    // Ensure starts with letter after potential prefix trim.
    if (!/^[a-z]/.test(base)) {
      base = `ws_${base}`;
    }

    for (let i = 0; i < MAX_SLUG_COLLISION_ATTEMPTS; i++) {
      const candidate = i === 0 ? base : `${base}_${i + 1}`;
      if (!(await this.workspaceExists(candidate))) {
        return candidate;
      }
    }
    throw new InternalServerErrorException(
      `Could not find a free workspace_id slug for "${name}" after ${MAX_SLUG_COLLISION_ATTEMPTS} attempts`,
    );
  }

  /**
   * Validate + reserve an explicit workspace_id (D2 migration path). The id
   * must match the same regex `CreateWorkspaceDto` enforces (`^[a-z][a-z0-9_]*$`,
   * 2..50) and must not already exist (→ 409, the caller adopts an id, not
   * overwrites a live workspace).
   */
  private async useExplicitWorkspaceId(id: string): Promise<string> {
    if (!/^[a-z][a-z0-9_]*$/.test(id) || id.length < 2 || id.length > 50) {
      throw new ConflictException({
        error: 'invalid_workspace_id',
        message:
          'Explicit workspace_id must match ^[a-z][a-z0-9_]*$ and be 2..50 chars.',
      });
    }
    if (await this.workspaceExists(id)) {
      throw new ConflictException({
        error: 'workspace_already_exists',
        message: `Workspace ${id} already exists.`,
      });
    }
    return id;
  }

  private async workspaceExists(id: string): Promise<boolean> {
    const rows = await this.clickhouse.querySystem<{ id: string }>(
      `SELECT id FROM workspaces
       WHERE id = {id:String}
         AND (id, updated_at) IN (
           SELECT id, max(updated_at) FROM workspaces GROUP BY id
         )
       LIMIT 1`,
      { id },
    );
    return rows.length > 0;
  }

  /**
   * Derive a sensible display name when the DTO only carries a business name.
   * Falls back to the local part of the email if `name` looks too generic.
   */
  private deriveUserName(workspaceName: string, email: string): string {
    const trimmed = workspaceName.trim();
    if (trimmed.length >= 2 && trimmed.length <= 100) {
      return trimmed;
    }
    return email.split('@')[0];
  }

  private async softDeleteUserSilently(userId: string): Promise<void> {
    try {
      // `deletedBy` = the user themselves, since there is no acting user
      // record in M2M context (platform admin has no DB user).
      await this.usersService.delete(userId, userId);
    } catch (err) {
      // Don't mask the original error; just log.
      this.logger.error(
        `[provision] compensation: soft-delete user ${userId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Best-effort phone-number forwarding to the bridge service.
   *
   * Coordination with the `phone-source-dim` agent:
   *   - The bridge endpoint `POST /api/admin/tenant/:wsId/phone-numbers`
   *     is OWNED by that agent (table `TenantPhoneNumber`).
   *   - If BRIDGE_URL or BRIDGE_ADMIN_API_KEY env vars are NOT set, we
   *     skip silently — provisioning still succeeds.
   *   - If the bridge call fails per-number, we record `failed` but keep
   *     going. The Hub can retry from the response payload.
   */
  private async forwardPhoneNumbersToBridge(
    workspaceId: string,
    phoneNumbers: PhoneNumberDto[] | undefined,
  ): Promise<PhoneNumberProvisionStatus[]> {
    if (!phoneNumbers || phoneNumbers.length === 0) {
      return [];
    }

    const bridgeUrl = this.configService.get<string>('BRIDGE_URL');
    const bridgeKey = this.configService.get<string>('BRIDGE_ADMIN_API_KEY');

    if (!bridgeUrl || !bridgeKey) {
      this.logger.warn(
        `[provision] phoneNumbers ignored for ${workspaceId}: BRIDGE_URL/BRIDGE_ADMIN_API_KEY not configured. Hub must retry once bridge is online.`,
      );
      return phoneNumbers.map((p) => ({
        e164: p.e164,
        source: p.source,
        status: 'skipped_no_bridge',
      }));
    }

    const statuses: PhoneNumberProvisionStatus[] = [];
    for (const phone of phoneNumbers) {
      try {
        // TODO[phone-source-dim]: confirm exact endpoint shape with that agent's PR.
        // Current contract assumed:
        //   POST {BRIDGE_URL}/api/admin/tenant/{workspaceId}/phone-numbers
        //   Body: { e164, source }
        const res = await fetch(
          `${bridgeUrl.replace(/\/$/, '')}/api/admin/tenant/${encodeURIComponent(
            workspaceId,
          )}/phone-numbers`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bridgeKey}`,
            },
            body: JSON.stringify({ e164: phone.e164, source: phone.source }),
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          statuses.push({
            e164: phone.e164,
            source: phone.source,
            status: 'failed',
            error: `bridge_status_${res.status}: ${text.substring(0, 200)}`,
          });
        } else {
          statuses.push({
            e164: phone.e164,
            source: phone.source,
            status: 'attached',
          });
        }
      } catch (err) {
        statuses.push({
          e164: phone.e164,
          source: phone.source,
          status: 'failed',
          error: (err as Error).message,
        });
      }
    }
    return statuses;
  }

  /**
   * Issue a password reset token + send the magic-link email.
   *
   * Returns the full reset URL so the caller (Hub) can mirror "magic
   * link sent" UI without re-reading the email inbox.
   */
  private async createPasswordResetAndEmail(
    userId: string,
    email: string,
    userName: string,
  ): Promise<string> {
    const { token, hash } = generateToken();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000,
    );

    await this.clickhouse.insertSystem('password_reset_tokens', [
      {
        id: generateId(),
        user_id: userId,
        token_hash: hash,
        status: 'pending',
        expires_at: toClickHouseDateTime(expiresAt),
        created_at: toClickHouseDateTime(now),
        updated_at: toClickHouseDateTime(now),
      },
    ]);

    const resetUrl = `${this.appUrl()}/reset-password/${token}`;

    // Send the magic link (re-uses the existing password-reset template,
    // which already says "click to set your password").
    try {
      await this.mailService.sendPasswordReset('', email, {
        userName,
        resetUrl,
      });
    } catch (err) {
      // Don't fail provisioning if email send fails — the Hub still gets
      // the reset URL in the response and can re-trigger the email.
      this.logger.warn(
        `[provision] magic-link email failed for ${email}: ${(err as Error).message}. Reset URL still returned in response.`,
      );
    }
    return resetUrl;
  }

  private buildTrackerSnippet(workspaceId: string): string {
    const trackerOrigin = this.configService.get<string>(
      'TRACKER_PUBLIC_ORIGIN',
      'https://analytics-engine.app.veridian.site',
    );
    // We deliberately do NOT embed the API key in the public snippet:
    // tracker uses workspace_id only for event collection (CORS-permissive
    // /api/track* endpoints). The api_key returned in the response is for
    // server-to-server use by the Hub.
    // The browser tracker bundle is served by the SDK controller at
    // /sdk/v1/tracker.js (UMD `Staminads`). The bare /tracker.js path falls
    // through to the SPA console HTML and tracks nothing, so we MUST point the
    // snippet at the SDK route.
    return `<script async src="${trackerOrigin}/sdk/v1/tracker.js" data-workspace-id="${workspaceId}"></script>`;
  }

  private appUrl(): string {
    return this.configService.get<string>(
      'APP_URL',
      'http://localhost:5173',
    );
  }
}
