import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClickHouseService } from '../../database/clickhouse.service';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import { IdentityStitchService } from '../../events/identity-stitch.service';

/**
 * Re-stitch the first-touch acquisition of every HISTORICAL identified user of a
 * workspace (S6 Lot C, ticket
 * 2026-06-25-attribution-inscrit-stitch-crossdomain-et-canal-referral).
 *
 * Why this exists. `IdentityStitchService` (Lot A) only fires at the FIRST event
 * carrying a `user_id` — i.e. going forward, for users who log in AFTER S6
 * shipped. Users who signed up BEFORE S6 (Joséphine, Valentin, Michele on Yoga
 * Sculpt) never triggered a stitch: their `user_attribution` row is missing and
 * their sessions/goals have empty `first_touch_*`. This backfill walks the
 * historical `sessions` table, finds every distinct identified user, and runs
 * the EXACT SAME stitch logic over each of them.
 *
 * Design (the ONLY clean way — same constraints as ChannelBackfillService):
 *  - RE-USE the SAME `IdentityStitchService.stitch()` as real-time ingestion —
 *    NEVER a parallel matching logic that would drift. The 3-key join
 *    (session_id > visitor_id > fingerprint-windowed), the user_attribution
 *    upsert, and the sessions/goals denormalization all live in ONE place. This
 *    service is purely the "enumerate the historical user_ids and replay the
 *    stitch" loop.
 *  - On `sessions` (and, via the stitch, `goals`) — NOT `events` (TTL 7j, useless
 *    for history).
 *
 * Guarantees (inherited from the stitch + enforced here):
 *  - SCOPED: every query/mutation runs against `staminads_ws_<id>` only.
 *  - IDEMPOTENT: re-stitching a user yields the same ReplacingMergeTree row and
 *    the same denormalized columns; a second backfill run is a no-op.
 *  - TOTAL-PRESERVING: the stitch only writes user_attribution + UPDATEs two
 *    columns on the user's own rows. No row inserted/deleted on sessions/goals →
 *    count()/uniqExact() invariant.
 *  - SYNCHRONOUS: the stitch's denormalize runs with `mutations_sync=2`, so each
 *    user's rewrite is materialized before we move on (deterministic for verify).
 *  - Emits `backfill.completed` so AnalyticsService clears the workspace cache.
 */

export interface IdentityBackfillSummary {
  workspace_id: string;
  /** Distinct identified user_ids found in the historical sessions table. */
  users_scanned: number;
  /** Users for which a first-touch was resolved (a user_attribution row written). */
  users_stitched: number;
  /** Users with no recoverable first-touch (direct-only chain / no earlier session). */
  users_unresolved: number;
  /** Breakdown of the join key that linked each stitched user's chain. */
  by_method: {
    session_id: number;
    visitor_id: number;
    fingerprint: number;
  };
}

@Injectable()
export class IdentityBackfillService {
  private readonly logger = new Logger(IdentityBackfillService.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly workspacesService: WorkspacesService,
    private readonly identityStitch: IdentityStitchService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Re-stitch every historical identified user of a workspace. Synchronous;
   * returns once every user's rewrite is materialized.
   */
  async backfillIdentity(
    workspaceId: string,
  ): Promise<IdentityBackfillSummary> {
    // Validate workspace exists (throws NotFound otherwise).
    await this.workspacesService.get(workspaceId);

    const userIds = await this.listIdentifiedUsers(workspaceId);

    const summary: IdentityBackfillSummary = {
      workspace_id: workspaceId,
      users_scanned: userIds.length,
      users_stitched: 0,
      users_unresolved: 0,
      by_method: { session_id: 0, visitor_id: 0, fingerprint: 0 },
    };

    for (const userId of userIds) {
      // Re-use the SAME stitch as real-time ingestion. Awaited here (the public
      // `stitch()` is awaitable; only the ingestion path fires it fire-and-forget
      // via `scheduleStitch`). The stitch is best-effort per user: a single
      // user's failure must not abort the whole workspace backfill.
      let method: 'session_id' | 'visitor_id' | 'fingerprint' | null = null;
      try {
        method = await this.identityStitch.stitch(workspaceId, userId);
      } catch (err) {
        this.logger.warn(
          `identity backfill: stitch failed for ws=${workspaceId} ` +
            `user=${userId}: ${(err as Error).message} (skipping)`,
        );
        continue;
      }

      if (method) {
        summary.users_stitched += 1;
        summary.by_method[method] += 1;
      } else {
        summary.users_unresolved += 1;
      }
    }

    // Invalidate the analytics cache so the next query reflects the re-stitch.
    // (The per-user stitch already emits this, but a workspace with zero
    // resolvable users would otherwise never invalidate — emit once here to be
    // unconditional and explicit.)
    this.eventEmitter.emit('backfill.completed', { workspaceId });

    this.logger.log('Identity backfill completed', {
      workspaceId,
      users_scanned: summary.users_scanned,
      users_stitched: summary.users_stitched,
      users_unresolved: summary.users_unresolved,
    });

    return summary;
  }

  /**
   * The distinct identified user_ids present in the historical sessions table.
   * `sessions` is a ReplacingMergeTree, but we only need the set of user_ids, so
   * `DISTINCT` over the (possibly duplicated) parts is fine — FINAL is
   * unnecessary here and would only cost a merge. Empty/NULL user_ids (anonymous
   * sessions) are excluded.
   */
  private async listIdentifiedUsers(workspaceId: string): Promise<string[]> {
    const rows = await this.clickhouse.queryWorkspace<{ user_id: string }>(
      workspaceId,
      `SELECT DISTINCT user_id
       FROM sessions
       WHERE user_id IS NOT NULL AND user_id != ''`,
      {},
    );
    return rows.map((r) => r.user_id).filter((u): u is string => Boolean(u));
  }
}
