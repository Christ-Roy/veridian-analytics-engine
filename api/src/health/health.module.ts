import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * HealthModule — exposes the public `/api/health` probe.
 *
 * ClickHouseService is provided globally by DatabaseModule, so no import is
 * needed here.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
