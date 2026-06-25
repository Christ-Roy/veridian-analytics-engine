import { ClickHouseClient } from '@clickhouse/client';
import { MajorMigration } from './migration.interface';

/**
 * V12 Identity Attribution Migration (S6 — identity stitching first-touch,
 * ticket 2026-06-25-attribution-inscrit-stitch-crossdomain-et-canal-referral).
 *
 * The acquisition channel of an identified user was systematically WRONG: a
 * visitor arrives on the vitrine (real channel, e.g. Google Ads), then lands on
 * the app and logs in — but the /login session starts with no referrer, so it
 * is legitimately classified `direct`/`not-mapped`. Nothing linked the
 * anonymous first-touch session to the identified one (proven in prod on
 * Yoga Sculpt: Joséphine's Google-Ads vitrine session and her signup are two
 * unrelated rows). first_touch_* fixes that without rewriting the per-session
 * channel (which is correct as-is).
 *
 * This migration is ADDITIVE (non destructive — no DROP COLUMN, no data loss):
 *
 *   1. CREATE TABLE `user_attribution` (canonical per-user first/last touch).
 *   2. ADD COLUMN first_touch_channel / first_touch_channel_group to `sessions`
 *      and `goals` (denormalized so the existing query-builder exposes them as
 *      native dimensions — zero query-builder change).
 *   3. DROP + CREATE `sessions_mv` / `goals_mv` so they emit the two new columns
 *      (as empty literals — events carry no first_touch; the value is written
 *      post-hoc by IdentityStitchService). MVs do NOT pick up new target columns
 *      automatically — they must be recreated (cf V6/V10). Recreating them with
 *      the EXACT same definition is safe: the MV only fires on FUTURE inserts,
 *      historical sessions/goals are untouched.
 *
 * Fresh installs already get all of this via WORKSPACE_SCHEMAS
 * (`database/schemas.ts`); this migration upgrades installs already on major
 * version 11. The MV bodies below MUST stay byte-identical to those in
 * schemas.ts (sessions_mv / goals_mv) so a migrated install and a fresh install
 * converge to the same schema.
 */
export const V12IdentityAttributionMigration: MajorMigration = {
  majorVersion: 12,

  hasSystemMigration(): boolean {
    return false;
  },

  hasWorkspaceMigration(): boolean {
    return true;
  },

  async migrateSystem(): Promise<void> {
    // No system-level changes.
  },

  async migrateWorkspace(
    client: ClickHouseClient,
    workspaceDb: string,
  ): Promise<void> {
    console.log(
      `[V12 Migration] Identity attribution (user_attribution + first_touch_*) for ${workspaceDb}...`,
    );

    // --- 1. user_attribution table (idempotent). Must match WORKSPACE_SCHEMAS. ---
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${workspaceDb}.user_attribution (
          identity_key String,
          user_id String,
          first_touch_channel LowCardinality(String) DEFAULT '',
          first_touch_channel_group LowCardinality(String) DEFAULT '',
          first_touch_referrer String DEFAULT '',
          first_touch_referrer_domain String DEFAULT '',
          first_touch_landing_page String DEFAULT '',
          first_touch_landing_domain String DEFAULT '',
          first_touch_utm_source String DEFAULT '',
          first_touch_utm_medium String DEFAULT '',
          first_touch_utm_campaign String DEFAULT '',
          first_touch_utm_content String DEFAULT '',
          first_touch_at DateTime64(3),
          first_touch_session_id String DEFAULT '',
          first_touch_method LowCardinality(String) DEFAULT '',
          last_touch_channel LowCardinality(String) DEFAULT '',
          last_touch_channel_group LowCardinality(String) DEFAULT '',
          last_touch_referrer String DEFAULT '',
          last_touch_landing_page String DEFAULT '',
          last_touch_utm_source String DEFAULT '',
          last_touch_utm_medium String DEFAULT '',
          last_touch_at DateTime64(3),
          last_touch_session_id String DEFAULT '',
          referral_code String DEFAULT '',
          visitor_id String DEFAULT '',
          fingerprint String DEFAULT '',
          first_seen_at DateTime64(3),
          updated_at DateTime64(3) DEFAULT now64(3)
        ) ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY identity_key
      `,
    });

    // --- 2. first_touch_* columns on sessions + goals (idempotent). ---
    for (const table of ['sessions', 'goals']) {
      await client.command({
        query: `ALTER TABLE ${workspaceDb}.${table} ADD COLUMN IF NOT EXISTS first_touch_channel LowCardinality(String) DEFAULT ''`,
      });
      await client.command({
        query: `ALTER TABLE ${workspaceDb}.${table} ADD COLUMN IF NOT EXISTS first_touch_channel_group LowCardinality(String) DEFAULT ''`,
      });
    }

    // --- 3. Recreate the materialized views so the new columns flow (empty)
    //        from events → sessions / goals. Same caveat as V6/V10: a MV does
    //        not pick up new target columns; it must be dropped + recreated. ---
    console.log(`[V12 Migration] Recreating sessions_mv / goals_mv for ${workspaceDb}...`);

    await client.command({
      query: `DROP VIEW IF EXISTS ${workspaceDb}.sessions_mv`,
    });
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW ${workspaceDb}.sessions_mv
        TO ${workspaceDb}.sessions AS
        SELECT
          e.session_id as id,
          e.workspace_id,
          any(e.created_at) as created_at,
          max(e.updated_at) as updated_at,
          max(e.duration) as duration,
          countIf(e.name = 'screen_view') as pageview_count,
          toUInt32(if(isNaN(medianIf(e.page_duration, e.page_duration > 0)), 0, round(medianIf(e.page_duration, e.page_duration > 0)))) as median_page_duration,
          any(toYear(e.created_at)) as year,
          any(toMonth(e.created_at)) as month,
          any(toDayOfMonth(e.created_at)) as day,
          any(toDayOfWeek(e.created_at)) as day_of_week,
          any(toWeek(e.created_at)) as week_number,
          any(toHour(e.created_at)) as hour,
          any(toDayOfWeek(e.created_at) IN (6, 7)) as is_weekend,
          any(e.referrer) as referrer,
          any(e.referrer_domain) as referrer_domain,
          any(e.referrer_path) as referrer_path,
          any(e.is_direct) as is_direct,
          any(e.landing_page) as landing_page,
          any(e.landing_domain) as landing_domain,
          any(e.landing_path) as landing_path,
          argMax(e.path, e.updated_at) as exit_path,
          any(e.utm_source) as utm_source,
          any(e.utm_medium) as utm_medium,
          any(e.utm_campaign) as utm_campaign,
          any(e.utm_term) as utm_term,
          any(e.utm_content) as utm_content,
          any(e.utm_id) as utm_id,
          any(e.utm_id_from) as utm_id_from,
          any(e.channel) as channel,
          any(e.channel_group) as channel_group,
          CAST('' AS LowCardinality(String)) as first_touch_channel,
          CAST('' AS LowCardinality(String)) as first_touch_channel_group,
          any(e.stm_1) as stm_1,
          any(e.stm_2) as stm_2,
          any(e.stm_3) as stm_3,
          any(e.stm_4) as stm_4,
          any(e.stm_5) as stm_5,
          any(e.stm_6) as stm_6,
          any(e.stm_7) as stm_7,
          any(e.stm_8) as stm_8,
          any(e.stm_9) as stm_9,
          any(e.stm_10) as stm_10,
          any(e.screen_width) as screen_width,
          any(e.screen_height) as screen_height,
          any(e.viewport_width) as viewport_width,
          any(e.viewport_height) as viewport_height,
          any(e.user_agent) as user_agent,
          any(e.language) as language,
          any(e.timezone) as timezone,
          any(e.country) as country,
          any(e.region) as region,
          any(e.city) as city,
          any(e.latitude) as latitude,
          any(e.longitude) as longitude,
          any(e.browser) as browser,
          any(e.browser_type) as browser_type,
          any(e.os) as os,
          any(e.device) as device,
          any(e.connection_type) as connection_type,
          max(e.max_scroll) as max_scroll,
          countIf(e.name = 'goal') as goal_count,
          sumIf(e.goal_value, e.name = 'goal') as goal_value,
          any(e.sdk_version) as sdk_version,
          any(e.user_id) as user_id,
          any(e.visitor_id) as visitor_id,
          any(e.fingerprint) as fingerprint,
          any(e.ip) as ip
        FROM ${workspaceDb}.events e
        GROUP BY e.session_id, e.workspace_id
      `,
    });

    await client.command({
      query: `DROP VIEW IF EXISTS ${workspaceDb}.goals_mv`,
    });
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW ${workspaceDb}.goals_mv
        TO ${workspaceDb}.goals AS
        SELECT
          generateUUIDv4() as id,
          e.session_id,
          e.workspace_id,
          e.goal_name,
          e.goal_value,
          assumeNotNull(e.goal_timestamp) as goal_timestamp,
          e.path,
          e.page_number,
          e.properties,
          e.referrer,
          e.referrer_domain,
          e.is_direct,
          e.landing_page,
          e.landing_path,
          e.utm_source,
          e.utm_medium,
          e.utm_campaign,
          e.utm_term,
          e.utm_content,
          e.channel,
          e.channel_group,
          CAST('' AS LowCardinality(String)) as first_touch_channel,
          CAST('' AS LowCardinality(String)) as first_touch_channel_group,
          e.stm_1,
          e.stm_2,
          e.stm_3,
          e.stm_4,
          e.stm_5,
          e.stm_6,
          e.stm_7,
          e.stm_8,
          e.stm_9,
          e.stm_10,
          e.device,
          e.browser,
          e.os,
          e.country,
          e.region,
          e.city,
          e.language,
          e.browser_type,
          e.screen_width,
          e.screen_height,
          e.viewport_width,
          e.viewport_height,
          e.user_agent,
          e.connection_type,
          e.referrer_path,
          e.landing_domain,
          e.utm_id,
          e.utm_id_from,
          e.timezone,
          e.latitude,
          e.longitude,
          toYear(assumeNotNull(e.goal_timestamp)) as year,
          toMonth(assumeNotNull(e.goal_timestamp)) as month,
          toDayOfMonth(assumeNotNull(e.goal_timestamp)) as day,
          toDayOfWeek(assumeNotNull(e.goal_timestamp)) as day_of_week,
          toWeek(assumeNotNull(e.goal_timestamp)) as week_number,
          toHour(assumeNotNull(e.goal_timestamp)) as hour,
          toDayOfWeek(assumeNotNull(e.goal_timestamp)) IN (6, 7) as is_weekend,
          e.user_id,
          e.visitor_id,
          e.fingerprint,
          e.ip,
          e._version
        FROM ${workspaceDb}.events e
        WHERE e.name = 'goal'
      `,
    });

    console.log(`[V12 Migration] Completed for ${workspaceDb}`);
  },
};
