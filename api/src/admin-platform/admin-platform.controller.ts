import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminPlatformService } from './admin-platform.service';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
import { ProvisionTenantResponseDto } from './dto/provision-tenant-response.dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';

/**
 * Platform-level (M2M) admin endpoints.
 *
 * All routes here are gated by `PlatformAdminGuard` which validates the
 * shared `PLATFORM_ADMIN_API_KEY` env var via timing-safe comparison.
 * These endpoints are NOT for end-user (workspace-scoped) traffic — only
 * the Hub / provisioning skill should hold this key.
 */
@ApiTags('admin-platform')
@ApiSecurity('platform-admin-bearer')
@Controller('api/admin/platform')
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
}
