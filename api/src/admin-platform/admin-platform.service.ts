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

const PASSWORD_RESET_EXPIRY_HOURS = 24;
const MAX_SLUG_COLLISION_ATTEMPTS = 50;

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
  // Helpers
  // ---------------------------------------------------------------------------

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
    return `<script async src="${trackerOrigin}/tracker.js" data-workspace-id="${workspaceId}"></script>`;
  }

  private appUrl(): string {
    return this.configService.get<string>(
      'APP_URL',
      'http://localhost:5173',
    );
  }
}
