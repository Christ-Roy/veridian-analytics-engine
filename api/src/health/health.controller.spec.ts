import { HealthController } from './health.controller';
import { ClickHouseService } from '../database/clickhouse.service';
import { APP_VERSION, GIT_SHA } from '../version';

describe('HealthController', () => {
  let controller: HealthController;
  let clickhouse: { querySystem: jest.Mock };

  beforeEach(() => {
    clickhouse = { querySystem: jest.fn() };
    controller = new HealthController(
      clickhouse as unknown as ClickHouseService,
    );
  });

  it('does not inherit unrelated strict rate limiters', () => {
    for (const throttler of ['auth', 'default', 'ingest']) {
      expect(
        Reflect.getMetadata(`THROTTLER:SKIP${throttler}`, HealthController),
      ).toBe(true);
    }
    expect(
      Reflect.getMetadata('THROTTLER:LIMITanalytics', HealthController),
    ).toBe(600);
  });

  it('returns ok status when ClickHouse is reachable', async () => {
    clickhouse.querySystem.mockResolvedValue([{ '1': 1 }]);
    const res = await controller.health();
    expect(res.status).toBe('ok');
    expect(res.clickhouse).toBe('ok');
    expect(res.version).toBe(APP_VERSION);
    expect(typeof res.timestamp).toBe('string');
    // gitSha exposé pour le verdict de deploy prod (SHA du code servi).
    expect(res.gitSha).toBe(GIT_SHA);
    expect(typeof res.gitSha).toBe('string');
  });

  it('propagates the error when ClickHouse is unreachable', async () => {
    clickhouse.querySystem.mockRejectedValue(new Error('connection refused'));
    await expect(controller.health()).rejects.toThrow('connection refused');
  });
});
