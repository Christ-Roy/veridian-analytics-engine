import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClickHouseService } from '../../database/clickhouse.service';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import {
  deriveChannel,
  ChannelSignals,
} from '../../events/derive-channel';

/**
 * Re-derivation backfill of the acquisition channel (`channel` / `channel_group`)
 * for HISTORICAL rows.
 *
 * Why this exists (ticket 2026-06-24-channel-group-vide-sessions-historiques):
 * the channel is FROZEN at ingestion by `deriveChannel()` (good design:
 * attribution immutability). Rows ingested BEFORE the S1 attribution chantier
 * have `channel`/`channel_group` empty in storage, permanently — the
 * `sessions_mv` / `goals_mv` only fire on new inserts, never re-process the
 * past. The proof is an internal inconsistency: a session with
 * `utm_medium=email` but `channel_group=''` (deriveChannel WOULD classify it
 * `email`).
 *
 * Design (the ONLY clean way, per the ticket):
 *  - Re-use the SAME pure function `deriveChannel()` — NEVER a parallel SQL
 *    channel logic that would drift from ingestion.
 *  - Read the DISTINCT acquisition-signal tuples actually present in storage
 *    (utm_medium / utm_source / utm_id_from / referrer_domain / referrer /
 *    is_direct). On real data this set is tiny (a handful of tuples).
 *  - For each tuple, compute `deriveChannel()` in TS, then issue ONE
 *    `ALTER TABLE ... UPDATE channel=..., channel_group=...` matching EXACTLY
 *    that signal tuple (fully parameterized — injection-safe).
 *
 * Guarantees:
 *  - SCOPED: every mutation runs against `staminads_ws_<id>` only (workspace DBs
 *    are physically separate databases). Never touches another tenant.
 *  - IDEMPOTENT: re-deriving a row yields the same result; we only emit an
 *    UPDATE for a tuple whose stored (channel, channel_group) differs from the
 *    derived one. A second run is a no-op (0 mutations). This is what makes a
 *    future prod re-run safe.
 *  - TOTAL-PRESERVING: only the two channel columns are rewritten — no row is
 *    inserted or deleted, so `count()`/`uniqExact(id)` are invariant.
 *  - SYNCHRONOUS: mutations run with `mutations_sync=2` so the call returns once
 *    the data is actually rewritten (deterministic for on-premise verify).
 *  - Emits `backfill.completed` → AnalyticsService clears the workspace cache.
 */

export interface ChannelBackfillTuple {
  signals: ChannelSignals;
  storedChannel: string;
  storedChannelGroup: string;
  derivedChannel: string;
  derivedChannelGroup: string;
  rows: number;
  table: 'sessions' | 'goals';
  changed: boolean;
}

export interface ChannelBackfillSummary {
  workspace_id: string;
  sessions_scanned: number;
  goals_scanned: number;
  sessions_updated: number;
  goals_updated: number;
  /** Distinct signal tuples whose stored channel changed. */
  changes: Array<{
    table: 'sessions' | 'goals';
    from: { channel: string; channel_group: string };
    to: { channel: string; channel_group: string };
    rows: number;
  }>;
}

/** Acquisition-signal tuple as read from storage (one ClickHouse GROUP BY row). */
interface SignalRow {
  utm_medium: string;
  utm_source: string;
  utm_id_from: string;
  referrer_domain: string;
  referrer: string;
  channel: string;
  channel_group: string;
  rows: string | number;
}

@Injectable()
export class ChannelBackfillService {
  private readonly logger = new Logger(ChannelBackfillService.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly workspacesService: WorkspacesService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Re-derive channel/channel_group on all historical sessions AND goals of a
   * workspace. Synchronous; returns once the rewrite is materialized.
   */
  async backfillChannel(workspaceId: string): Promise<ChannelBackfillSummary> {
    // Validate workspace exists (throws NotFound otherwise).
    await this.workspacesService.get(workspaceId);

    const summary: ChannelBackfillSummary = {
      workspace_id: workspaceId,
      sessions_scanned: 0,
      goals_scanned: 0,
      sessions_updated: 0,
      goals_updated: 0,
      changes: [],
    };

    for (const table of ['sessions', 'goals'] as const) {
      const tuples = await this.readSignalTuples(workspaceId, table);
      let scanned = 0;
      let updated = 0;

      for (const t of tuples) {
        scanned += t.rows;
        if (!t.changed) continue;
        await this.applyTuple(workspaceId, table, t);
        updated += t.rows;
        summary.changes.push({
          table,
          from: { channel: t.storedChannel, channel_group: t.storedChannelGroup },
          to: {
            channel: t.derivedChannel,
            channel_group: t.derivedChannelGroup,
          },
          rows: t.rows,
        });
      }

      if (table === 'sessions') {
        summary.sessions_scanned = scanned;
        summary.sessions_updated = updated;
      } else {
        summary.goals_scanned = scanned;
        summary.goals_updated = updated;
      }
    }

    // Invalidate the analytics cache so the next query reflects the rewrite.
    this.eventEmitter.emit('backfill.completed', { workspaceId });

    this.logger.log('Channel backfill completed', {
      workspaceId,
      sessions_updated: summary.sessions_updated,
      goals_updated: summary.goals_updated,
      changes: summary.changes.length,
    });

    return summary;
  }

  /**
   * Read the distinct acquisition-signal tuples present in a table, with the
   * row count and the currently stored channel/channel_group, and pre-compute
   * the derived channel + whether it differs from storage.
   */
  private async readSignalTuples(
    workspaceId: string,
    table: 'sessions' | 'goals',
  ): Promise<ChannelBackfillTuple[]> {
    const rows = await this.clickhouse.queryWorkspace<SignalRow>(
      workspaceId,
      `SELECT
         utm_medium,
         utm_source,
         utm_id_from,
         referrer_domain,
         referrer,
         channel,
         channel_group,
         count() AS rows
       FROM ${table}
       GROUP BY
         utm_medium, utm_source, utm_id_from,
         referrer_domain, referrer, channel, channel_group`,
      {},
    );

    return rows.map((r) => {
      // NB: is_direct is intentionally NOT part of the signal tuple. deriveChannel
      // only reads it in the final `direct` fallback, and ONLY when there is
      // neither a medium nor a referrer domain — in which case the result is
      // `direct` regardless of is_direct's value. So is_direct never changes the
      // derived output given the other columns; including it would only split
      // tuples needlessly (and force a Bool param). We pass it as undefined and
      // rely on deriveChannel's `(!domain && !medium)` branch.
      const signals: ChannelSignals = {
        utm_medium: r.utm_medium,
        utm_source: r.utm_source,
        utm_id_from: r.utm_id_from,
        referrer_domain: r.referrer_domain,
        referrer: r.referrer,
      };
      const derived = deriveChannel(signals);
      const changed =
        derived.channel !== r.channel ||
        derived.channel_group !== r.channel_group;
      return {
        signals,
        storedChannel: r.channel,
        storedChannelGroup: r.channel_group,
        derivedChannel: derived.channel,
        derivedChannelGroup: derived.channel_group,
        rows: Number(r.rows ?? 0),
        table,
        changed,
      };
    });
  }

  /**
   * Apply the derived channel to all rows matching EXACTLY one signal tuple.
   * Fully parameterized: identifiers are fixed, every value is a bound param.
   * Runs synchronously (`mutations_sync=2`) so the data is rewritten before we
   * return. Scoped to the workspace database by `commandWorkspaceWithParams`.
   */
  private async applyTuple(
    workspaceId: string,
    table: 'sessions' | 'goals',
    t: ChannelBackfillTuple,
  ): Promise<void> {
    const s = t.signals;
    await this.clickhouse.commandWorkspaceWithParams(
      workspaceId,
      `ALTER TABLE ${table}
         UPDATE channel = {channel:String},
                channel_group = {channel_group:String}
       WHERE utm_medium = {utm_medium:String}
         AND utm_source = {utm_source:String}
         AND utm_id_from = {utm_id_from:String}
         AND referrer_domain = {referrer_domain:String}
         AND referrer = {referrer:String}
         AND channel = {old_channel:String}
         AND channel_group = {old_channel_group:String}
       SETTINGS mutations_sync = 2`,
      {
        channel: t.derivedChannel,
        channel_group: t.derivedChannelGroup,
        utm_medium: s.utm_medium ?? '',
        utm_source: s.utm_source ?? '',
        utm_id_from: s.utm_id_from ?? '',
        referrer_domain: s.referrer_domain ?? '',
        referrer: s.referrer ?? '',
        old_channel: t.storedChannel,
        old_channel_group: t.storedChannelGroup,
      },
    );
  }
}
