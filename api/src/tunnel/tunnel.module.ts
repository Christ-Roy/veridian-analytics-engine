import { Module, forwardRef } from '@nestjs/common';
import { ExportModule } from '../export/export.module';
import { MembersModule } from '../members/members.module';
import { TunnelController } from './tunnel.controller';
import { TunnelAggregateService } from './tunnel-aggregate.service';

/**
 * TunnelModule — integration surface for the tunnel bridge.
 * Exposes GET /api/tunnel.aggregate (analytics aggregates, §5).
 * Reuses ExportService for the cursor-paginated event read; MembersModule
 * backs the WorkspaceAuthGuard + permission check.
 */
@Module({
  imports: [ExportModule, forwardRef(() => MembersModule)],
  controllers: [TunnelController],
  providers: [TunnelAggregateService],
  exports: [TunnelAggregateService],
})
export class TunnelModule {}
