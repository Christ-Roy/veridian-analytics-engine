import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminPlatformService } from './admin-platform.service';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
import { ProvisionTenantResponseDto } from './dto/provision-tenant-response.dto';
import { ProvisionApiKeyDto } from './dto/provision-api-key.dto';
import { RevokeApiKeyDto } from './dto/revoke-api-key.dto';
import { ListWorkspaceApiKeysDto } from './dto/list-api-keys.dto';
import { WorkspaceStatusDto } from './dto/workspace-status.dto';
import { WorkspaceStatusResponseDto } from './dto/workspace-status-response.dto';
import {
  VoipAddPhoneNumberDto,
  VoipCredentialKindDto,
  VoipRemovePhoneNumberDto,
  VoipSaveCredentialDto,
  VoipWorkspaceDto,
} from './dto/voip-admin.dto';
import { GscResyncDto, GscStatusDto } from './dto/gsc-admin.dto';
import { UpdateWorkspaceSettingsM2MDto } from './dto/update-workspace-settings.dto';
import { AdsConversionsDto } from './dto/ads-conversions.dto';
import { AdsConversionsResponseDto } from './dto/ads-conversions-response.dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { Public } from '../common/decorators/public.decorator';
import { AnalyticsQueryDto } from '../analytics/dto/analytics-query.dto';
import {
  CreateWebhookDto,
  DeleteWebhookDto,
  ListWebhooksDto,
  TestWebhookDto,
} from '../webhooks/dto/create-webhook.dto';

/**
 * Platform-level (M2M) admin endpoints.
 *
 * All routes here are gated by `PlatformAdminGuard` which validates the
 * shared `PLATFORM_ADMIN_API_KEY` env var via timing-safe comparison.
 * These endpoints are NOT for end-user (workspace-scoped) traffic — only
 * the Hub / provisioning skill should hold this key.
 *
 * `@Public()` bypasses the global `JwtAuthGuard` (which would reject the
 * Bearer M2M key as "not a JWT"). The route is NOT actually public — it
 * is protected by `PlatformAdminGuard` at controller level. Global
 * throttler still runs (skipped only in NODE_ENV=test).
 */
@ApiTags('admin-platform')
@ApiSecurity('platform-admin-bearer')
@Controller('api/admin/platform')
@Public()
@UseGuards(PlatformAdminGuard)
export class AdminPlatformController {
  constructor(
    private readonly adminPlatformService: AdminPlatformService,
  ) {}

  @Post('tenants.provision')
  @ApiOperation({
    summary:
      'Provision a brand-new tenant (workspace + owner user + admin API key + magic-link invite) in one M2M call.',
  })
  provisionTenant(
    @Body() dto: ProvisionTenantDto,
  ): Promise<ProvisionTenantResponseDto> {
    return this.adminPlatformService.provisionTenant(dto);
  }

  @Post('workspaces.provisionApiKey')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Provision a workspace-scoped API key for an EXISTING platform-managed workspace (no members). M2M only.',
  })
  provisionApiKey(@Body() dto: ProvisionApiKeyDto) {
    return this.adminPlatformService.provisionApiKey({
      workspace_id: dto.workspace_id,
      name: dto.name,
      role: dto.role,
    });
  }

  @Post('workspaces.revokeApiKey')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Revoke a workspace-scoped API key for a platform-managed workspace (no members). Identify by key_id OR key_prefix. M2M only. Symmetric of provisionApiKey.',
  })
  revokeApiKey(@Body() dto: RevokeApiKeyDto) {
    return this.adminPlatformService.revokeApiKey({
      workspace_id: dto.workspace_id,
      key_id: dto.key_id,
      key_prefix: dto.key_prefix,
    });
  }

  @Post('workspaces.listApiKeys')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'List the API keys (metadata only, never the secret) of a platform-managed workspace for audit. M2M only.',
  })
  listApiKeys(@Body() dto: ListWorkspaceApiKeysDto) {
    return this.adminPlatformService.listApiKeys({
      workspace_id: dto.workspace_id,
      status: dto.status,
    });
  }

  @Post('analytics.query')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Run an analytics query for any workspace (M2M). Same contract as POST /api/analytics.query but gated by the platform admin key instead of a workspace-scoped key. Used by the bridge for tenant score/status/check-tracker.',
  })
  analyticsQuery(@Body() dto: AnalyticsQueryDto) {
    return this.adminPlatformService.analyticsQuery(dto);
  }

  // ─── Lot A — Consolidated workspace status ────────────────────────────

  @Post('workspaces.status')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Consolidated status of a workspace (M2M): existence, tracking liveness, GSC / VoIP / webhooks connectors, and tracker snippet. The single call an IA makes to know if a tenant is fully wired.',
  })
  workspaceStatus(
    @Body() dto: WorkspaceStatusDto,
  ): Promise<WorkspaceStatusResponseDto> {
    return this.adminPlatformService.getConsolidatedStatus(dto.workspace_id);
  }

  // ─── Lot B — VoIP M2M ─────────────────────────────────────────────────

  @Post('voip.listPhoneNumbers')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List a workspace’s tracked phone numbers + allowed sources (M2M).',
  })
  voipListPhoneNumbers(@Body() dto: VoipWorkspaceDto) {
    return this.adminPlatformService.voipListPhoneNumbers(dto.workspace_id);
  }

  @Post('voip.addPhoneNumber')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Map a phone number (E.164) to a traffic source for a workspace (M2M).',
  })
  voipAddPhoneNumber(@Body() dto: VoipAddPhoneNumberDto) {
    return this.adminPlatformService.voipAddPhoneNumber(dto);
  }

  @Post('voip.removePhoneNumber')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete a tracked phone number by id (M2M).' })
  voipRemovePhoneNumber(@Body() dto: VoipRemovePhoneNumberDto) {
    return this.adminPlatformService.voipRemovePhoneNumber(
      dto.workspace_id,
      dto.id,
    );
  }

  @Post('voip.listCredentials')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'List a workspace’s VoIP credentials (masked — secrets never returned) (M2M).',
  })
  voipListCredentials(@Body() dto: VoipWorkspaceDto) {
    return this.adminPlatformService.voipListCredentials(dto.workspace_id);
  }

  @Post('voip.saveCredential')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Register/replace a VoIP credential (M2M). `creds` is write-only: encrypted at rest, never echoed back. Lets an IA wire OVH/Telnyx end-to-end.',
  })
  voipSaveCredential(@Body() dto: VoipSaveCredentialDto) {
    return this.adminPlatformService.voipSaveCredential(dto);
  }

  @Post('voip.testCredential')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Test a VoIP credential against the provider API (M2M).',
  })
  voipTestCredential(@Body() dto: VoipCredentialKindDto) {
    return this.adminPlatformService.voipTestCredential(dto);
  }

  @Post('voip.deleteCredential')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete a VoIP credential (M2M).' })
  voipDeleteCredential(@Body() dto: VoipCredentialKindDto) {
    return this.adminPlatformService.voipDeleteCredential(dto);
  }

  @Post('voip.sync')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Trigger an immediate VoIP sync (M2M). Runs across all active credentials (the cron is global); requires a valid workspace_id so the call stays scoped/auditable.',
  })
  voipSync(@Body() dto: VoipWorkspaceDto) {
    return this.adminPlatformService.voipSync(dto.workspace_id);
  }

  // ─── Lot C — GSC M2M (status + resync; OAuth stays human/browser) ─────

  @Post('gsc.status')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Read the GSC connection state of a workspace (M2M). No tokens exposed. Note: gsc.begin/callback (OAuth consent) stay human/browser — not exposed in M2M.',
  })
  gscStatus(@Body() dto: GscStatusDto) {
    return this.adminPlatformService.gscStatus(dto.workspace_id);
  }

  @Post('gsc.resync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Trigger an immediate GSC sync for a connected workspace (M2M).',
  })
  gscResync(@Body() dto: GscResyncDto) {
    return this.adminPlatformService.gscResync(dto.workspace_id, dto.days);
  }

  // ─── Lot D — Webhooks / Twenty connectors M2M ─────────────────────────

  @Post('webhooks.list')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List webhook destinations of a workspace (M2M). Secrets never returned.',
  })
  webhooksList(@Body() dto: ListWebhooksDto) {
    return this.adminPlatformService.webhooksList(dto);
  }

  @Post('webhooks.create')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Create a webhook destination (M2M). SSRF-protected by WebhooksService; auth secret is write-only.',
  })
  webhooksCreate(@Body() dto: CreateWebhookDto) {
    return this.adminPlatformService.webhooksCreate(dto);
  }

  @Post('webhooks.delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete a webhook destination (M2M).' })
  webhooksDelete(@Body() dto: DeleteWebhookDto) {
    return this.adminPlatformService.webhooksDelete(dto);
  }

  @Post('webhooks.test')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Synchronous test delivery to a webhook destination (M2M). Returns the result inline.',
  })
  webhooksTest(@Body() dto: TestWebhookDto) {
    return this.adminPlatformService.webhooksTest(dto);
  }

  // ─── Lot E — Workspace settings M2M ───────────────────────────────────

  @Post('workspaces.updateSettings')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Update a workspace’s settings (M2M): timezone, currency, name, status, logo, and deep settings (annotations, smtp, geo, filters).',
  })
  updateWorkspaceSettings(@Body() dto: UpdateWorkspaceSettingsM2MDto) {
    return this.adminPlatformService.updateWorkspaceSettings(dto);
  }

  // ─── Lot F — ads.conversions (read-only Ads-attributed conversions) ───

  @Post('ads.conversions')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Read a workspace’s Google Ads-attributed conversions (M2M, read-only) so an IA / the google-ads skill can upload them to the Ads API. No Ads credentials/OAuth/upload here. Bounded by date range (default 28d) + row cap (default 1000, max 10000).',
  })
  adsConversions(
    @Body() dto: AdsConversionsDto,
  ): Promise<AdsConversionsResponseDto> {
    return this.adminPlatformService.getAdsConversions(dto);
  }
}
