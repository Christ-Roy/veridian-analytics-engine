import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { join } from 'path';
import { validate } from './config/env.validation';
import { AnalyticsModule } from './analytics/analytics.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AssistantModule } from './assistant/assistant.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { DemoModule } from './demo/demo.module';
import { EventsModule } from './events/events.module';
import { ExportModule } from './export/export.module';
import { FiltersModule } from './filters/filters.module';
import { HealthModule } from './health/health.module';
import { InvitationsModule } from './invitations/invitations.module';
import { MailModule } from './mail/mail.module';
import { MembersModule } from './members/members.module';
import { SdkModule } from './sdk/sdk.module';
import { SetupModule } from './setup/setup.module';
import { SetupMiddleware } from './setup/setup.middleware';
import { SmtpModule } from './smtp/smtp.module';
import { ToolsModule } from './tools/tools.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { VoipModule } from './voip/voip.module';
import { GscModule } from './gsc/gsc.module';
import { TunnelModule } from './tunnel/tunnel.module';
// IMPORTANT — AdminPlatformModule MUST stay LAST in this ES-module import
// block. It imports several domain modules (Users/Workspaces/ApiKeys/Mail)
// which themselves participate in forwardRef cycles with MembersModule /
// AuthModule / SmtpModule. If `admin-platform.module.ts` is evaluated
// BEFORE the other domain modules' files have finished loading,
// `MembersModule.imports[0] = UsersModule` (non-forwardRef, see
// members.module.ts) resolves to `undefined` due to ES-module TDZ →
// Nest scanner crashes with "The module at index [0] … is undefined"
// → all 444 e2e suites fall over. Keeping AdminPlatformModule last in
// the import order forces the standard module graph to finish loading
// first, then this orchestrator slots in cleanly. See CI run
// 26391278819 for the original failure that proved this is load-bearing.
import { AdminPlatformModule } from './admin-platform/admin-platform.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, 'public'),
      // `/sdk/*` is owned by SdkController (explicit Cache-Control + CORS).
      // Without this exclude, ServeStatic would shadow the controller and
      // serve the raw file without the headers integrators need.
      exclude: ['/api/{*path}', '/health', '/sdk/{*path}'],
    }),
    CacheModule.register({
      isGlobal: true,
      ttl: 24 * 60 * 60 * 1000, // 24 hours in ms
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Disable rate limiting in test mode by setting extremely high limits
        const isTest =
          config.get<string>('NODE_ENV') === 'test' ||
          config.get<string>('CLICKHOUSE_SYSTEM_DATABASE')?.includes('test');
        if (isTest) {
          return {
            throttlers: [
              { name: 'auth', ttl: 1, limit: 1000000 },
              { name: 'default', ttl: 1, limit: 1000000 },
              { name: 'analytics', ttl: 1, limit: 1000000 },
            ],
          };
        }
        return {
          throttlers: [
            { name: 'auth', ttl: 60000, limit: 10 },
            { name: 'default', ttl: 60000, limit: 100 },
            { name: 'analytics', ttl: 60000, limit: 1000 },
          ],
        };
      },
    }),
    DatabaseModule,
    CommonModule,
    SetupModule,
    AuthModule,
    AuditModule,
    UsersModule,
    WorkspacesModule,
    ApiKeysModule,
    SmtpModule,
    MailModule,
    InvitationsModule,
    MembersModule,
    FiltersModule,
    ToolsModule,
    DemoModule,
    HealthModule,
    EventsModule,
    ExportModule,
    AnalyticsModule,
    AssistantModule,
    SubscriptionsModule,
    WebhooksModule,
    VoipModule,
    GscModule,
    TunnelModule,
    SdkModule,
    AdminPlatformModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SetupMiddleware).forRoutes('*');
  }
}
