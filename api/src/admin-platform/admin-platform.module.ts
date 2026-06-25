import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminPlatformController } from './admin-platform.controller';
import { AdminPlatformService } from './admin-platform.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { SsrfGuard } from '../common/ssrf-guard';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { MailModule } from '../mail/mail.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { VoipModule } from '../voip/voip.module';
import { GscModule } from '../gsc/gsc.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { FiltersModule } from '../filters/filters.module';
import { ExportModule } from '../export/export.module';

/**
 * Module exposing platform-level (M2M) admin endpoints.
 *
 * Mounted under `/api/admin/platform/*`. All routes are protected by
 * `PlatformAdminGuard` (Bearer PLATFORM_ADMIN_API_KEY).
 *
 * Re-uses existing domain services (UsersService, WorkspacesService,
 * ApiKeysService, MailService) — no domain logic is reimplemented here.
 * This module is essentially an orchestrator.
 *
 * ⚠️  ES-module circular-import safety: every domain module imported here
 *     is wrapped in `forwardRef()`. The existing `MembersModule` has a
 *     non-forwardRef `imports: [UsersModule, ...]` clause which creates a
 *     latent TDZ when `AdminPlatformModule` is the first ES-module entry
 *     evaluated under `AppModule`. Without forwardRef wrappers here,
 *     `users.module.ts` is mid-evaluation when `members.module.ts` reads
 *     `UsersModule` → its `imports[0]` resolves to `undefined` → Nest
 *     bails with "The module at index [0] … is undefined". The forwardRef
 *     defers each lookup until all module files finished loading and
 *     `MembersModule` sees a defined `UsersModule`. See CI run
 *     26391278819 for the original stack trace.
 */
@Module({
  imports: [
    ConfigModule,
    forwardRef(() => UsersModule),
    forwardRef(() => WorkspacesModule),
    forwardRef(() => ApiKeysModule),
    forwardRef(() => MailModule),
    forwardRef(() => AnalyticsModule),
    forwardRef(() => VoipModule),
    forwardRef(() => GscModule),
    forwardRef(() => WebhooksModule),
    // S6 Lot C — IdentityBackfillService lives in FiltersModule (it re-uses
    // IdentityStitchService for the historical re-stitch).
    forwardRef(() => FiltersModule),
    // prospect360 — reuses ExportService.getUserEvents (the per-user journey)
    // under the platform key. ExportModule exports ExportService.
    forwardRef(() => ExportModule),
  ],
  controllers: [AdminPlatformController],
  providers: [AdminPlatformService, PlatformAdminGuard, SsrfGuard],
})
export class AdminPlatformModule {}
