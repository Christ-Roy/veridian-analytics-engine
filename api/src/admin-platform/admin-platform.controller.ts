import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminPlatformService } from './admin-platform.service';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
import { ProvisionTenantResponseDto } from './dto/provision-tenant-response.dto';
import { ProvisionApiKeyDto } from './dto/provision-api-key.dto';
import { RevokeApiKeyDto } from './dto/revoke-api-key.dto';
import { ListWorkspaceApiKeysDto } from './dto/list-api-keys.dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { Public } from '../common/decorators/public.decorator';
import { AnalyticsQueryDto } from '../analytics/dto/analytics-query.dto';

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
}
