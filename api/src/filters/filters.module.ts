import { Module, forwardRef } from '@nestjs/common';
import { FiltersController } from './filters.controller';
import { FiltersService } from './filters.service';
import { FilterBackfillService } from './backfill/backfill.service';
import { ChannelBackfillService } from './backfill/channel-backfill.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MembersModule } from '../members/members.module';

@Module({
  imports: [WorkspacesModule, forwardRef(() => MembersModule)],
  controllers: [FiltersController],
  providers: [FiltersService, FilterBackfillService, ChannelBackfillService],
  exports: [FiltersService, FilterBackfillService, ChannelBackfillService],
})
export class FiltersModule {}
