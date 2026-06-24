import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClickHouseService } from '../database/clickhouse.service';
import { Public } from '../common/decorators/public.decorator';
import { APP_VERSION, GIT_SHA } from '../version';

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
    gitSha: string;
    clickhouse: 'ok';
    timestamp: string;
  }> {
    // A trivial query is enough to assert the OLAP store is reachable.
    await this.clickhouse.querySystem<{ '1': number }>('SELECT 1');
    return {
      status: 'ok',
      version: APP_VERSION,
      // SHA du commit servi (injecté au build) — le verdict de deploy prod
      // confirme que health.gitSha == SHA déployé (preuve du BON code, pas
      // juste d'un code sain). 'unknown' hors-CI.
      gitSha: GIT_SHA,
      clickhouse: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
