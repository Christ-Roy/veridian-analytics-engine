import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MembersModule } from '../members/members.module';
import { EventsModule } from '../events/events.module';
import { VoipController } from './voip.controller';
import { VoipService } from './voip.service';
import { VoipCrypto } from './voip-crypto.service';
import { VoipSyncService } from './voip-sync.service';

/**
 * Module VoIP natif — connecteur Calls OVH/Telnyx (option A, ticket
 * 2026-06-16). Remplace `veridian-bridge/src/voip/` + le cron GH Action.
 *
 * - `VoipService`     : CRUD creds (chiffrés) + numéros trackés (source).
 * - `VoipSyncService` : `@Cron` qui pull les CDR et pousse les events
 *   `phone_call` EN INTERNE via `EventBufferService` (events natifs).
 * - `VoipCrypto`      : AES-256-GCM clé-par-workspace (common/crypto).
 */
@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => MembersModule),
    EventsModule,
  ],
  controllers: [VoipController],
  providers: [VoipService, VoipCrypto, VoipSyncService],
  exports: [VoipService],
})
export class VoipModule {}
