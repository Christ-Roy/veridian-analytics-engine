import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClickHouseService } from '../database/clickhouse.service';
import { Public } from '../common/decorators/public.decorator';
import { APP_VERSION } from '../version';

/**
 * Lightweight liveness/readiness probe.
 *
 * Used by:
 *  - Docker/Traefik healthchecks for the public demo instance
 *  - the daily smoke check (cron) before re-seeding the demo
 *  - external monitoring (`obs check`)
 *
 * Returns 200 with `{ status: 'ok' }` when the API is up and ClickHouse is
 * reachable, 503 otherwise. Public (no auth) by design — a probe must not
 * require credentials.
 */
@ApiTags('health')
@Controller('api')
export class HealthController {
  constructor(private readonly clickhouse: ClickHouseService) {}

  @Get('health')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Liveness/readiness probe' })
  async health(): Promise<{
    status: 'ok';
    version: string;
    clickhouse: 'ok';
    timestamp: string;
  }> {
    // A trivial query is enough to assert the OLAP store is reachable.
    await this.clickhouse.querySystem<{ '1': number }>('SELECT 1');
    return {
      status: 'ok',
      version: APP_VERSION,
      clickhouse: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
