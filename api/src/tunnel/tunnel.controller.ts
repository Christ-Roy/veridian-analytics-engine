import { Controller, Get, Query, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WorkspaceAuthGuard } from '../common/guards/workspace.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { TunnelAggregateService } from './tunnel-aggregate.service';
import { TunnelAggregateQueryDto } from './dto/tunnel-aggregate-query.dto';

/**
 * Tunnel integration endpoints — analytics aggregates consumed by the tunnel
 * bridge (veridian-tunnel-de-vente). Cf CONTRATS-TUNNEL §7 + task #5.
 *
 * The engine exposes the AnalyticsAggregate contract ONLY. It never computes or
 * writes person.score — the bridge fuses these aggregates with its Notifuse
 * signals and owns the score (§4c.4).
 */
@ApiTags('tunnel')
@ApiSecurity('api-key')
@ApiSecurity('jwt-auth')
@Controller('api')
export class TunnelController {
  constructor(private readonly aggregates: TunnelAggregateService) {}

  @Get('tunnel.aggregate')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('analytics.export')
  @ApiOperation({
    summary: 'Per-identity analytics aggregate for the tunnel bridge.',
    description:
      'Returns the AnalyticsAggregate contract per identity (audit slug or ' +
      'normalized email) over a window (default last 48h). The bridge fuses ' +
      'these with its Notifuse signals to compute the tunnel score. The engine ' +
      'never writes person.score.',
  })
  @ApiResponse({ status: 200, description: 'Analytics aggregates + scanned window.' })
  async aggregate(@Query() query: TunnelAggregateQueryDto) {
    const result = await this.aggregates.aggregate({
      workspace_id: query.workspace_id,
      since: query.since,
      until: query.until,
    });
    return {
      workspace_id: query.workspace_id,
      window: result.window,
      aggregates: result.aggregates,
    };
  }
}
