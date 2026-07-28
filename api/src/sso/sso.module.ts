import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SsoController } from './sso.controller';
import { SsoService } from './sso.service';
import { HubHmacGuard } from './guards/hub-hmac.guard';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

/**
 * Module SSO — autologin Hub → Analytics.
 *
 * `ClickHouseService` et `AuditService` viennent de modules @Global, donc pas
 * besoin de les importer. `AuthModule` fournit `AuthService.issueSessionForUser`
 * pour que les sessions SSO soient les mêmes objets que les sessions issues
 * d'un login classique (même durée, même révocabilité).
 */
@Module({
  imports: [
    ConfigModule,
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
  ],
  controllers: [SsoController],
  providers: [SsoService, HubHmacGuard],
  exports: [SsoService],
})
export class SsoModule {}
