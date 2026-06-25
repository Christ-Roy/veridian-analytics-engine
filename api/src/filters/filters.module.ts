import { Module, forwardRef } from '@nestjs/common';
import { FiltersController } from './filters.controller';
import { FiltersService } from './filters.service';
import { FilterBackfillService } from './backfill/backfill.service';
import { ChannelBackfillService } from './backfill/channel-backfill.service';
import { IdentityBackfillService } from './backfill/identity-backfill.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MembersModule } from '../members/members.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    WorkspacesModule,
    forwardRef(() => MembersModule),
    // For IdentityBackfillService → re-uses IdentityStitchService (Lot A) so the
    // backfill matching logic is the SAME as real-time ingestion (zero drift).
    EventsModule,
  ],
  controllers: [FiltersController],
  providers: [
    FiltersService,
    FilterBackfillService,
    ChannelBackfillService,
    IdentityBackfillService,
  ],
  exports: [
    FiltersService,
    FilterBackfillService,
    ChannelBackfillService,
    IdentityBackfillService,
  ],
})
export class FiltersModule {}
