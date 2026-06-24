import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterBackfillService } from './backfill.service';
import { ClickHouseService } from '../../database/clickhouse.service';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import { BackfillTask } from './backfill-task.entity';

/** A complete BackfillTask fixture, overridable per-test. */
function task(over: Partial<BackfillTask> = {}): BackfillTask {
  return {
    id: 'task-1',
    workspace_id: 'ws-1',
    status: 'running',
    lookback_days: 30,
    chunk_size_days: 7,
    batch_size: 1000,
    total_sessions: 100,
    processed_sessions: 50,
    total_events: 200,
    processed_events: 100,
    current_date_chunk: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    started_at: null,
    completed_at: null,
    error_message: null,
    retry_count: 0,
    filters_snapshot: '[]',
    ...over,
  };
}

describe('FilterBackfillService', () => {
  let service: FilterBackfillService;
  let clickhouse: jest.Mocked<ClickHouseService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FilterBackfillService,
        {
          provide: ClickHouseService,
          useValue: {
            querySystem: jest.fn().mockResolvedValue([]),
            insertSystem: jest.fn().mockResolvedValue(undefined),
            commandSystemWithParams: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WorkspacesService,
          useValue: { get: jest.fn().mockResolvedValue({ id: 'ws-1' }) },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<FilterBackfillService>(FilterBackfillService);
    clickhouse = module.get(ClickHouseService);
  });

  describe('getTaskStatus', () => {
    it('throws NotFound when the task does not exist', async () => {
      clickhouse.querySystem.mockResolvedValue([]);
      await expect(service.getTaskStatus('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('maps a found task to its progress projection', async () => {
      clickhouse.querySystem.mockResolvedValue([task()] as never);
      const progress = await service.getTaskStatus('task-1');
      expect(progress.id).toBe('task-1');
      expect(progress.status).toBe('running');
      // 50/100 sessions (0.7) + 100/200 events (0.3) → 50%.
      expect(progress.progress_percent).toBe(50);
      expect(progress.sessions).toEqual({ processed: 50, total: 100 });
    });
  });

  describe('updateTaskStatus', () => {
    it('persists the new status with a completed_at stamp on terminal states', async () => {
      await service.updateTaskStatus(task(), 'failed', 'boom');
      expect(clickhouse.insertSystem).toHaveBeenCalledWith(
        'backfill_tasks',
        expect.arrayContaining([
          expect.objectContaining({
            status: 'failed',
            error_message: 'boom',
            completed_at: expect.any(String),
          }),
        ]),
      );
    });
  });

  describe('updateTaskStatusWithRetry', () => {
    it('retries on failure then succeeds (logs warn via Logger, no throw)', async () => {
      jest.useFakeTimers();
      try {
        const warnSpy = jest
          .spyOn(service['logger'], 'warn')
          .mockImplementation(() => undefined);
        clickhouse.insertSystem
          .mockRejectedValueOnce(new Error('CH blip'))
          .mockResolvedValue(undefined);

        const promise = service.updateTaskStatusWithRetry(
          task(),
          'completed',
          undefined,
          3,
        );
        // Advance past the first backoff (1s) so attempt 2 fires.
        await jest.advanceTimersByTimeAsync(1500);
        await expect(promise).resolves.toBeUndefined();

        // One failed attempt → one Logger.warn (proves the console→Logger
        // refactor routes through the NestJS Logger, not raw console).
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(clickhouse.insertSystem).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
