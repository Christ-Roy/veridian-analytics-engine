import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MembersModule } from '../members/members.module';
import { GscController } from './gsc.controller';
import { GscService } from './gsc.service';
import { GscQueryService } from './gsc-query.service';
import { GscOauthService } from './gsc-oauth.service';
import { GscSyncService } from './gsc-sync.service';
import { GscRepository } from './gsc.repository';
import { GscTokenCrypto } from './gsc-token-crypto';
import { GscSyncScheduler } from './gsc-sync.scheduler';

/**
 * Module Search Console natif (port du bridge Express).
 *
 * - OAuth Google + sync + query + cron, 100 % dans l'engine.
 * - `MembersModule` (forwardRef) : requis par `WorkspaceAuthGuard` pour valider
 *   l'appartenance JWT au workspace, comme le module webhooks.
 * - Tokens chiffrés clé-par-workspace (`GscTokenCrypto` sur `common/crypto`).
 */
@Module({
  imports: [DatabaseModule, forwardRef(() => MembersModule)],
  controllers: [GscController],
  providers: [
    GscService,
    GscQueryService,
    GscOauthService,
    GscSyncService,
    GscRepository,
    GscTokenCrypto,
    GscSyncScheduler,
  ],
  exports: [GscService, GscQueryService],
})
export class GscModule {}
