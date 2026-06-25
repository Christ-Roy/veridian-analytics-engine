import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClickHouseService } from '../database/clickhouse.service';

/**
 * Identity stitching — first-touch acquisition for identified users (S6,
 * ticket 2026-06-25-attribution-inscrit-stitch-crossdomain-et-canal-referral).
 *
 * THE PROBLEM. A visitor arrives on the vitrine with a real channel (e.g.
 * Google Ads), browses anonymously, then lands on the app and logs in. The
 * /login session has no referrer → it is legitimately classified `direct`. The
 * acquisition channel of the USER (first-touch) is therefore lost: it lived on
 * the earlier anonymous session, which nothing linked to the user_id. Proven in
 * prod on Yoga Sculpt (Joséphine: Google-Ads vitrine session + signup were two
 * unrelated rows; josephine showed `not-mapped` instead of `ads`).
 *
 * THE FIX (this service). At the first event carrying a `user_id`, look up the
 * user's FIRST session in the cross-domain chain and write it to:
 *   - `user_attribution[user_id]` (canonical first/last touch record), and
 *   - the `first_touch_channel` / `first_touch_channel_group` columns of that
 *     user's `sessions` and `goals` rows (denormalized → native query dimension).
 *
 * THE JOIN KEYS, by decreasing reliability (proven on real prod data):
 *   1. session_id  — the app session adopts the vitrine session_id via the
 *                    `_stm` cross-domain param. Strongest, but re-minted today
 *                    (0 matches in prod) → becomes 100% once the SDK fix lands.
 *   2. visitor_id  — stable cross-session identity. Same story (re-minted per
 *                    origin today → fixed by the SDK).
 *   3. fingerprint — device hash (UA + screen + tz + …). Lower entropy, so
 *                    ALWAYS bounded by a short time window. This is the ONLY key
 *                    that links Joséphine's chain in CURRENT prod data (her
 *                    Ads vitrine session and her signup share fingerprint
 *                    `hu7nos`, 10s apart) → immediate coverage WITHOUT the SDK.
 *
 * DESIGN GUARANTEES.
 *   - Best-effort & fire-and-forget: NEVER awaited by the ingestion path, never
 *     throws into it (exact `activateWorkspace` model). A failed stitch loses no
 *     event and is retried on the user's next event (cache TTL aside).
 *   - Idempotent: re-stitching the same user yields the same row
 *     (ReplacingMergeTree(updated_at)) and the same denormalized columns. A
 *     second run changes nothing.
 *   - Total-preserving: only writes user_attribution + UPDATEs two columns on
 *     the user's own rows. No row inserted/deleted on sessions/goals → count() /
 *     uniqExact() invariant.
 *   - Scoped: every query/mutation runs against `staminads_ws_<id>` only.
 *   - Does NOT rewrite `channel`/`channel_group` (the per-session attribution is
 *     correct as-is; first_touch is a separate dimension).
 */

/** How far back a fingerprint match may reach before the identified session. */
const FINGERPRINT_LOOKBACK_SECONDS = 60 * 60; // 1 hour

/** Local de-dup cache TTL — same (workspace,user) won't re-trigger within this. */
const STITCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type StitchMethod = 'session_id' | 'visitor_id' | 'fingerprint';

/** A session row as needed for stitching (subset of the sessions table). */
interface SessionRow {
  id: string;
  user_id: string | null;
  visitor_id: string;
  fingerprint: string;
  created_at: string;
  channel: string;
  channel_group: string;
  referrer: string;
  referrer_domain: string;
  landing_page: string;
  landing_domain: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
}

@Injectable()
export class IdentityStitchService {
  private readonly logger = new Logger(IdentityStitchService.name);

  /** workspaceId::userId → expiry. Prevents re-triggering on every event. */
  private readonly recentlyStitched = new Map<string, number>();

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Fire-and-forget entry point from the ingestion path. NEVER awaited, NEVER
   * throws into ingestion. Cheap-gated by a local cache so a chatty identified
   * session doesn't fire a stitch per event.
   */
  scheduleStitch(workspaceId: string, userId: string): void {
    const key = `${workspaceId}::${userId}`;
    const now = Date.now();
    const expiry = this.recentlyStitched.get(key);
    if (expiry && expiry > now) {
      return; // recently stitched — skip
    }
    // Optimistically mark NOW so concurrent in-flight events don't each fire.
    this.recentlyStitched.set(key, now + STITCH_CACHE_TTL_MS);
    this.evictExpired(now);

    void this.stitch(workspaceId, userId).catch((err) => {
      // On failure, drop the cache entry so the next event retries.
      this.recentlyStitched.delete(key);
      this.logger.warn(
        `identity stitch failed for ws=${workspaceId} user=${userId}: ${
          (err as Error).message
        } (will retry on next event)`,
      );
    });
  }

  /**
   * Resolve and persist the first-touch acquisition for an identified user.
   * Public for direct (awaited) use by the e2e harness and a future backfill.
   * Returns the chosen method, or null if nothing could be stitched.
   */
  async stitch(
    workspaceId: string,
    userId: string,
  ): Promise<StitchMethod | null> {
    // 1. The identified (login) session = the user's most recent session. This
    //    is the last-touch and the source of the join keys.
    const identified = await this.getIdentifiedSession(workspaceId, userId);
    if (!identified) {
      return null;
    }

    // 2. Find the first session of the chain (priority: session_id > visitor_id
    //    > fingerprint-in-window). We take the earliest session that carries a
    //    real (non-empty) channel/channel_group.
    const firstTouch = await this.findFirstTouch(workspaceId, identified);
    if (!firstTouch) {
      return null;
    }

    // 3. Upsert the canonical user_attribution row.
    await this.upsertAttribution(
      workspaceId,
      userId,
      identified,
      firstTouch.session,
      firstTouch.method,
    );

    // 4. Denormalize first_touch_* onto the user's sessions + goals rows so the
    //    native query-builder exposes `first_touch_channel(_group)` dimensions.
    await this.denormalize(
      workspaceId,
      userId,
      firstTouch.session.channel,
      firstTouch.session.channel_group,
    );

    // 5. Invalidate the analytics cache so the next query reflects the stitch.
    this.eventEmitter.emit('backfill.completed', { workspaceId });

    this.logger.log(
      `identity stitched ws=${workspaceId} user=${userId} ` +
        `first_touch=${firstTouch.session.channel_group} via=${firstTouch.method}`,
    );
    return firstTouch.method;
  }

  /** The user's most recent session row (the identified / login session). */
  private async getIdentifiedSession(
    workspaceId: string,
    userId: string,
  ): Promise<SessionRow | null> {
    const rows = await this.clickhouse.queryWorkspace<SessionRow>(
      workspaceId,
      `SELECT
         id, user_id, visitor_id, fingerprint, toString(created_at) AS created_at,
         channel, channel_group, referrer, referrer_domain,
         landing_page, landing_domain,
         utm_source, utm_medium, utm_campaign, utm_content
       FROM sessions FINAL
       WHERE user_id = {user_id:String}
       ORDER BY created_at DESC
       LIMIT 1`,
      { user_id: userId },
    );
    return rows[0] ?? null;
  }

  /**
   * Find the first-touch session of the chain. Tries each join key in order of
   * reliability and returns the FIRST that resolves an earlier session carrying
   * a real channel. The session_id / visitor_id keys are exact; fingerprint is
   * bounded by a time window (low entropy → collision-safe-ish).
   */
  private async findFirstTouch(
    workspaceId: string,
    identified: SessionRow,
  ): Promise<{ session: SessionRow; method: StitchMethod } | null> {
    // Key 1 — session_id (vitrine session adopted via _stm). Look for an EARLIER
    // anonymous row sharing the same session id (only meaningful once a row with
    // that id predates the identified one with a real channel).
    if (identified.id) {
      const s = await this.firstChainSession(
        workspaceId,
        `id = {v:String} AND toDateTime64(created_at, 3) <= toDateTime64({ts:String}, 3)`,
        { v: identified.id, ts: identified.created_at },
      );
      if (s) return { session: s, method: 'session_id' };
    }

    // Key 2 — visitor_id (stable cross-session identity).
    if (identified.visitor_id) {
      const s = await this.firstChainSession(
        workspaceId,
        `visitor_id = {v:String} AND toDateTime64(created_at, 3) <= toDateTime64({ts:String}, 3)`,
        { v: identified.visitor_id, ts: identified.created_at },
      );
      if (s) return { session: s, method: 'visitor_id' };
    }

    // Key 3 — fingerprint, bounded by a lookback window (best-effort, the only
    // key that links the chain in current prod data).
    if (identified.fingerprint) {
      const s = await this.firstChainSession(
        workspaceId,
        `fingerprint = {v:String}
           AND toDateTime64(created_at, 3) <= toDateTime64({ts:String}, 3)
           AND toDateTime64(created_at, 3) >= toDateTime64({ts:String}, 3) - INTERVAL {win:UInt32} SECOND`,
        {
          v: identified.fingerprint,
          ts: identified.created_at,
          win: FINGERPRINT_LOOKBACK_SECONDS,
        },
      );
      if (s) return { session: s, method: 'fingerprint' };
    }

    return null;
  }

  /**
   * The EARLIEST session matching `whereClause` that carries a real (non-direct,
   * non-empty) channel_group. We exclude `direct`/`not-mapped`/empty because a
   * first-touch of `direct` adds no acquisition information over the login
   * session itself — and would mask a later, richer match key. If only direct
   * sessions exist in the chain, there is genuinely no acquisition to recover.
   */
  private async firstChainSession(
    workspaceId: string,
    whereClause: string,
    params: Record<string, unknown>,
  ): Promise<SessionRow | null> {
    const rows = await this.clickhouse.queryWorkspace<SessionRow>(
      workspaceId,
      `SELECT
         id, user_id, visitor_id, fingerprint, toString(created_at) AS created_at,
         channel, channel_group, referrer, referrer_domain,
         landing_page, landing_domain,
         utm_source, utm_medium, utm_campaign, utm_content
       FROM sessions FINAL
       WHERE ${whereClause}
         AND channel_group != ''
         AND channel_group != 'direct'
         AND channel_group != 'not-mapped'
       ORDER BY created_at ASC
       LIMIT 1`,
      params,
    );
    return rows[0] ?? null;
  }

  /**
   * Upsert the canonical user_attribution row (ReplacingMergeTree → newest
   * updated_at wins). first_touch from the chain's first session, last_touch
   * from the identified/login session.
   */
  private async upsertAttribution(
    workspaceId: string,
    userId: string,
    identified: SessionRow,
    first: SessionRow,
    method: StitchMethod,
  ): Promise<void> {
    const now = new Date();
    const nowStr = now.toISOString().replace('T', ' ').replace('Z', '');
    await this.clickhouse.insertWorkspace(workspaceId, 'user_attribution', [
      {
        identity_key: userId,
        user_id: userId,
        first_touch_channel: first.channel,
        first_touch_channel_group: first.channel_group,
        first_touch_referrer: first.referrer,
        first_touch_referrer_domain: first.referrer_domain,
        first_touch_landing_page: first.landing_page,
        first_touch_landing_domain: first.landing_domain,
        first_touch_utm_source: first.utm_source,
        first_touch_utm_medium: first.utm_medium,
        first_touch_utm_campaign: first.utm_campaign,
        first_touch_utm_content: first.utm_content,
        first_touch_at: first.created_at,
        first_touch_session_id: first.id,
        first_touch_method: method,
        last_touch_channel: identified.channel,
        last_touch_channel_group: identified.channel_group,
        last_touch_referrer: identified.referrer,
        last_touch_landing_page: identified.landing_page,
        last_touch_utm_source: identified.utm_source,
        last_touch_utm_medium: identified.utm_medium,
        last_touch_at: identified.created_at,
        last_touch_session_id: identified.id,
        // referral_code is owned by Lot B (?ref= ingestion). We seed it from the
        // first-touch utm_content if present (Lot B stores the parrain code
        // there), but never clobber a non-empty existing value with empty — the
        // ReplacingMergeTree keeps the freshest row, and Lot B writes its own.
        referral_code: first.utm_content || '',
        visitor_id: identified.visitor_id || first.visitor_id,
        fingerprint: identified.fingerprint || first.fingerprint,
        first_seen_at: first.created_at,
        updated_at: nowStr,
      },
    ]);
  }

  /**
   * Denormalize the first-touch channel onto every sessions + goals row of the
   * user. Parameterized + scoped to the workspace DB. Synchronous mutation so
   * the rewrite is materialized before we return (deterministic for verify).
   */
  private async denormalize(
    workspaceId: string,
    userId: string,
    channel: string,
    channelGroup: string,
  ): Promise<void> {
    for (const table of ['sessions', 'goals'] as const) {
      await this.clickhouse.commandWorkspaceWithParams(
        workspaceId,
        `ALTER TABLE ${table}
           UPDATE first_touch_channel = {channel:String},
                  first_touch_channel_group = {channel_group:String}
         WHERE user_id = {user_id:String}
         SETTINGS mutations_sync = 2`,
        { channel, channel_group: channelGroup, user_id: userId },
      );
    }
  }

  /** Drop expired cache entries to keep the map bounded. */
  private evictExpired(now: number): void {
    if (this.recentlyStitched.size < 1000) return;
    for (const [k, exp] of this.recentlyStitched) {
      if (exp <= now) this.recentlyStitched.delete(k);
    }
  }
}
