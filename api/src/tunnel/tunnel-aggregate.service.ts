import { Injectable, Logger } from '@nestjs/common';
import { ExportService } from '../export/export.service';
import { AnalyticsAggregate } from './entities/analytics-aggregate';
import {
  aggregateEvents,
  toAggregates,
  RawEventRow,
  AggregateAccumulator,
} from './tunnel-aggregator';

/**
 * TunnelAggregateService — engine-native analytics aggregation for the tunnel
 * bridge (task #5). Replaces what bridge/src/analytics-pull.ts did by pulling
 * raw events and folding them itself: the engine is now the source of truth for
 * its OWN aggregated data, the bridge consumes a ready-to-fuse aggregate.
 *
 * It REUSES ExportService.getUserEvents (the existing cursor-paginated, FINAL,
 * user_id-scoped reader) instead of duplicating a ClickHouse query — single
 * source of truth for the read path.
 *
 * The engine NEVER computes or writes person.score: it returns the
 * AnalyticsAggregate contract only; the bridge fuses Notifuse signals +
 * computeTunnelScore and owns the score (§4c.4).
 */

export interface TunnelAggregateResult {
  aggregates: AnalyticsAggregate[];
  /** ISO window actually scanned. */
  window: { since: string; until: string };
  /** True when the safety page cap was hit before all events were read. */
  truncated: boolean;
  /** Resume cursor when truncated (bridge re-calls with it); null otherwise. */
  next_cursor: string | null;
}

/** Default lookback window — matches the bridge's fixed 48h sweep (sync.ts). */
const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Page size used to walk events internally (mirrors getUserEvents max). */
const PAGE_SIZE = 1000;
/** Safety cap on pages scanned per call (1000 × 200 = 200k events). */
const MAX_PAGES = 200;

@Injectable()
export class TunnelAggregateService {
  private readonly logger = new Logger(TunnelAggregateService.name);

  constructor(private readonly exportService: ExportService) {}

  /**
   * Compute the complete per-identity analytics aggregate over [since, until].
   * Walks the cursor internally so the bridge receives finished aggregates, not
   * per-page fragments to merge.
   *
   * @param params.cursor optional resume cursor (from a previous truncated
   *   response) — when present it drives the first page instead of `since`.
   */
  async aggregate(params: {
    workspace_id: string;
    since?: string;
    until?: string;
    cursor?: string;
  }): Promise<TunnelAggregateResult> {
    const until = params.until ?? new Date().toISOString();
    const since =
      params.since ?? new Date(Date.parse(until) - DEFAULT_WINDOW_MS).toISOString();

    let acc: Map<string, AggregateAccumulator> | undefined;
    let cursor: string | null = params.cursor ?? null;
    let pages = 0;

    do {
      const page = await this.exportService.getUserEvents({
        workspace_id: params.workspace_id,
        until,
        // since drives the first page; the cursor takes over afterwards.
        ...(cursor ? { cursor } : { since }),
        limit: PAGE_SIZE,
      });
      acc = aggregateEvents(page.data as unknown as RawEventRow[], acc);
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);

    // Safety cap hit with events still unread: the aggregates are PARTIAL.
    // Surface a resume cursor + flag so the bridge can continue from here
    // instead of silently scoring on truncated data (a missing session would
    // under-score a hot lead). The bridge re-calls with this cursor.
    const truncated = cursor !== null;
    if (truncated) {
      this.logger.warn(
        `tunnel.aggregate truncated at ${MAX_PAGES} pages for ws=${params.workspace_id} ` +
          `(window ${since}..${until}); returning resume cursor.`,
      );
    }

    return {
      aggregates: acc ? toAggregates(acc) : [],
      window: { since, until },
      truncated,
      next_cursor: truncated ? cursor : null,
    };
  }
}
