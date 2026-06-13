import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminPlatformService } from './admin-platform.service';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
import { ProvisionTenantResponseDto } from './dto/provision-tenant-response.dto';
import { ProvisionApiKeyDto } from './dto/provision-api-key.dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { Public } from '../common/decorators/public.decorator';

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
}
