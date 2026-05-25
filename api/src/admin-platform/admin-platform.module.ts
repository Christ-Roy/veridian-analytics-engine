import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminPlatformController } from './admin-platform.controller';
import { AdminPlatformService } from './admin-platform.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { MailModule } from '../mail/mail.module';

/**
 * Module exposing platform-level (M2M) admin endpoints.
 *
 * Mounted under `/api/admin/platform/*`. All routes are protected by
 * `PlatformAdminGuard` (Bearer PLATFORM_ADMIN_API_KEY).
 *
 * Re-uses existing domain services (UsersService, WorkspacesService,
 * ApiKeysService, MailService) — no domain logic is reimplemented here.
 * This module is essentially an orchestrator.
 */
@Module({
  imports: [
    ConfigModule,
    UsersModule,
    WorkspacesModule,
    ApiKeysModule,
    MailModule,
  ],
  controllers: [AdminPlatformController],
  providers: [AdminPlatformService, PlatformAdminGuard],
})
export class AdminPlatformModule {}
