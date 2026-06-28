/**
 * Unit tests for DemoTenantService.
 *
 * ClickHouse + WorkspacesService are mocked: these assert the ORCHESTRATION
 * (guard logic, the wipe SQL shape, the preserved_real before/after audit,
 * the is_demo flag toggling). The REAL-ClickHouse behaviour (the TTL scenario,
 * actual row removal, real-data preservation) is proven in
 * api/test/demo-tenant.e2e-spec.ts against an ephemeral ClickHouse.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ClickHouseService } from '../../database/clickhouse.service';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import { DemoTenantService } from './demo-tenant.service';
import { DEMO_SESSION_PREFIX } from './demo-tenant.generator';

describe('DemoTenantService', () => {
  let service: DemoTenantService;
  let clickhouse: jest.Mocked<ClickHouseService>;
  let workspaces: jest.Mocked<WorkspacesService>;

  const WS = 'ws_demo';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DemoTenantService,
        {
          provide: ClickHouseService,
          useValue: {
            queryWorkspace: jest.fn().mockResolvedValue([{ c: '0' }]),
            insertWorkspace: jest.fn().mockResolvedValue(undefined),
            insertSystem: jest.fn().mockResolvedValue(undefined),
            commandWorkspaceWithParams: jest.fn().mockResolvedValue(undefined),
            commandSystemWithParams: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WorkspacesService,
          useValue: {
            get: jest
              .fn()
              .mockResolvedValue({ id: WS, website: 'https://x.fr', settings: {} }),
            update: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    service = module.get(DemoTenantService);
    clickhouse = module.get(ClickHouseService);
    workspaces = module.get(WorkspacesService);
  });

  describe('seed', () => {
    it('refuses 409 DEMO_REAL_DATA_PRESENT when real events exist and not forced', async () => {
      // countRealEvents → 5 real events (every read returns 5; the guard trips
      // on the first one before any other query runs).
      clickhouse.queryWorkspace.mockResolvedValue([{ c: '5' }] as never);
      expect.assertions(3);
      try {
        await service.seed({ workspaceId: WS });
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        const body = (e as ConflictException).getResponse() as { code: string };
        expect(body.code).toBe('DEMO_REAL_DATA_PRESENT');
      }
      expect(clickhouse.insertWorkspace).not.toHaveBeenCalled();
    });

    it('seeds, inserts events, flips is_demo=true and returns counts', async () => {
      // 1st read = countRealEvents guard → 0 (no real data). Subsequent reads
      // (waitForSessionsMaterialized + count*) → high so the MV-wait settles
      // immediately instead of polling to its deadline.
      clickhouse.queryWorkspace
        .mockResolvedValueOnce([{ c: '0' }] as never)
        .mockResolvedValue([{ c: '999' }] as never);
      const res = await service.seed({
        workspaceId: WS,
        sessionCount: 10,
        voipCount: 3,
        daysRange: 7,
      });
      expect(res.is_demo).toBe(true);
      expect(res.run_id).toMatch(/^[0-9a-f]{8}$/);
      expect(res.seeded.web_sessions).toBe(10);
      expect(res.seeded.voip_calls).toBe(3);
      // events inserted into the workspace.
      expect(clickhouse.insertWorkspace).toHaveBeenCalledWith(
        WS,
        'events',
        expect.any(Array),
      );
      // is_demo=true via WorkspacesService.update.
      expect(workspaces.update).toHaveBeenCalledWith({
        id: WS,
        settings: { is_demo: true },
      });
    });

    it('force:true bypasses the real-data guard', async () => {
      // Even with lots of real data, force skips the guard. High counts also
      // settle the MV-wait immediately.
      clickhouse.queryWorkspace.mockResolvedValue([{ c: '999' }] as never);
      await expect(
        service.seed({ workspaceId: WS, sessionCount: 5, voipCount: 0, force: true }),
      ).resolves.toBeDefined();
      expect(clickhouse.insertWorkspace).toHaveBeenCalled();
    });

    it('404 when workspace does not exist', async () => {
      workspaces.get.mockRejectedValueOnce(new NotFoundException('nope'));
      await expect(service.seed({ workspaceId: 'ghost' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('wipe', () => {
    it('issues a prefix-scoped DELETE on every table with mutations_sync=2', async () => {
      // demo counts non-zero so the wipe runs; real counts stable before/after.
      // Order of count* calls: countDemoRows(4) → countRealRows before(4) →
      // [wipe] → countRealRows after(4). We return demo=10 for the first 4,
      // then real=7 for the remaining reads (stable → intact).
      let call = 0;
      clickhouse.queryWorkspace.mockImplementation(async () => {
        call += 1;
        return (call <= 4 ? [{ c: '10' }] : [{ c: '7' }]) as never;
      });

      const res = await service.wipe(WS);

      expect(res.is_demo).toBe(false);
      expect(res.noop).toBe(false);
      expect(res.preserved_real.intact).toBe(true);
      expect(res.preserved_real.before).toEqual(res.preserved_real.after);

      // One ALTER DELETE per data table, all prefix-scoped + synchronous.
      const deleteCalls = clickhouse.commandWorkspaceWithParams.mock.calls;
      expect(deleteCalls).toHaveLength(4);
      for (const [, sql, params] of deleteCalls) {
        expect(sql).toContain('DELETE WHERE startsWith(');
        expect(sql).toContain('mutations_sync=2');
        expect(params).toEqual({ prefix: DEMO_SESSION_PREFIX });
      }
      // is_demo cleared.
      expect(workspaces.update).toHaveBeenCalledWith({
        id: WS,
        settings: { is_demo: false },
      });
    });

    it('is a clean no-op when there is no demo data (no DELETE issued)', async () => {
      clickhouse.queryWorkspace.mockResolvedValue([{ c: '0' }] as never);
      const res = await service.wipe(WS);
      expect(res.noop).toBe(true);
      expect(res.deleted).toEqual({ events: 0, sessions: 0, pages: 0, goals: 0 });
      expect(res.preserved_real.intact).toBe(true);
      expect(clickhouse.commandWorkspaceWithParams).not.toHaveBeenCalled();
      // Flag still cleared (idempotent).
      expect(workspaces.update).toHaveBeenCalledWith({
        id: WS,
        settings: { is_demo: false },
      });
    });
  });

  describe('status', () => {
    it('reports is_demo + mock/real counts', async () => {
      workspaces.get.mockResolvedValueOnce({
        id: WS,
        website: 'https://x.fr',
        settings: { is_demo: true },
      } as never);
      clickhouse.queryWorkspace.mockResolvedValue([{ c: '3' }] as never);
      const res = await service.status(WS);
      expect(res.is_demo).toBe(true);
      expect(res.exists).toBe(true);
      expect(res.mock_rows.events).toBe(3);
      expect(res.real_rows.events).toBe(3);
    });
  });
});
