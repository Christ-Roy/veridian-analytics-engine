import { AnalyticsTable } from './tables';

export interface DimensionDefinition {
  name: string;
  column: string;
  type: 'string' | 'number' | 'boolean';
  category: string;
  tables: AnalyticsTable[];
}

export const DIMENSIONS: Record<string, DimensionDefinition> = {
  // Traffic (sessions and goals)
  referrer: {
    name: 'referrer',
    column: 'referrer',
    type: 'string',
    category: 'Traffic',
    tables: ['sessions', 'goals'],
  },
  referrer_domain: {
    name: 'referrer_domain',
    column: 'referrer_domain',
    type: 'string',
    category: 'Traffic',
    tables: ['sessions', 'goals'],
  },
  referrer_path: {
    name: 'referrer_path',
    column: 'referrer_path',
    type: 'string',
    category: 'Traffic',
    tables: ['sessions', 'goals'],
  },
  is_direct: {
    name: 'is_direct',
    column: 'is_direct',
    type: 'boolean',
    category: 'Traffic',
    tables: ['sessions', 'goals'],
  },

  // UTM (sessions and goals)
  utm_source: {
    name: 'utm_source',
    column: 'utm_source',
    type: 'string',
    category: 'UTM',
    tables: ['sessions', 'goals'],
  },
  utm_medium: {
    name: 'utm_medium',
    column: 'utm_medium',
    type: 'string',
    category: 'UTM',
    tables: ['sessions', 'goals'],
  },
  utm_campaign: {
    name: 'utm_campaign',
    column: 'utm_campaign',
    type: 'string',
    category: 'UTM',
    tables: ['sessions', 'goals'],
  },
  utm_term: {
    name: 'utm_term',
    column: 'utm_term',
    type: 'string',
    category: 'UTM',
    tables: ['sessions', 'goals'],
  },
  utm_content: {
    name: 'utm_content',
    column: 'utm_content',
    type: 'string',
    category: 'UTM',
    tables: ['sessions', 'goals'],
  },

  // Channel (sessions and goals)
  channel: {
    name: 'channel',
    column: 'channel',
    type: 'string',
    category: 'Channel',
    tables: ['sessions', 'goals'],
  },
  channel_group: {
    name: 'channel_group',
    column: 'channel_group',
    type: 'string',
    category: 'Channel',
    tables: ['sessions', 'goals'],
  },

  // First-touch acquisition (S6 identity stitching, 2026-06-25).
  // The session/goal `channel`/`channel_group` is the acquisition of THAT
  // session (the /login session is legitimately `direct`). first_touch_* is a
  // SEPARATE dimension: the channel of the user's VERY FIRST session in the
  // cross-domain chain (e.g. the anonymous vitrine visit via Google Ads),
  // stitched onto the identified user by `IdentityStitchService` and
  // denormalized onto that user's sessions/goals rows. The canonical per-user
  // record lives in the `user_attribution` table (read by the M2M provenance
  // endpoint + the Twenty connector). Empty until a user is identified AND
  // their first-touch session is reachable (same session_id/visitor_id chain).
  first_touch_channel: {
    name: 'first_touch_channel',
    column: 'first_touch_channel',
    type: 'string',
    category: 'Channel',
    tables: ['sessions', 'goals'],
  },
  first_touch_channel_group: {
    name: 'first_touch_channel_group',
    column: 'first_touch_channel_group',
    type: 'string',
    category: 'Channel',
    tables: ['sessions', 'goals'],
  },

  // Session Pages (sessions and some on goals)
  landing_page: {
    name: 'landing_page',
    column: 'landing_page',
    type: 'string',
    category: 'Session Pages',
    tables: ['sessions', 'goals'],
  },
  landing_domain: {
    name: 'landing_domain',
    column: 'landing_domain',
    type: 'string',
    category: 'Session Pages',
    tables: ['sessions', 'goals'],
  },
  landing_path: {
    name: 'landing_path',
    column: 'landing_path',
    type: 'string',
    category: 'Session Pages',
    tables: ['sessions', 'goals'],
  },
  exit_path: {
    name: 'exit_path',
    column: 'exit_path',
    type: 'string',
    category: 'Session Pages',
    tables: ['sessions'],
  },

  // Page (pages table only)
  page_path: {
    name: 'page_path',
    column: 'path',
    type: 'string',
    category: 'Page',
    tables: ['pages'],
  },
  page_number: {
    name: 'page_number',
    column: 'page_number',
    type: 'number',
    category: 'Page',
    tables: ['pages'],
  },
  is_landing_page: {
    name: 'is_landing_page',
    column: 'is_landing',
    type: 'boolean',
    category: 'Page',
    tables: ['pages'],
  },
  is_exit_page: {
    name: 'is_exit_page',
    column: 'is_exit',
    type: 'boolean',
    category: 'Page',
    tables: ['pages'],
  },
  page_entry_type: {
    name: 'page_entry_type',
    column: 'entry_type',
    type: 'string',
    category: 'Page',
    tables: ['pages'],
  },

  // Device (sessions and some on goals)
  device: {
    name: 'device',
    column: 'device',
    type: 'string',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  browser: {
    name: 'browser',
    column: 'browser',
    type: 'string',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  browser_type: {
    name: 'browser_type',
    column: 'browser_type',
    type: 'string',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  os: {
    name: 'os',
    column: 'os',
    type: 'string',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  screen_width: {
    name: 'screen_width',
    column: 'screen_width',
    type: 'number',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  screen_height: {
    name: 'screen_height',
    column: 'screen_height',
    type: 'number',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  viewport_width: {
    name: 'viewport_width',
    column: 'viewport_width',
    type: 'number',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  viewport_height: {
    name: 'viewport_height',
    column: 'viewport_height',
    type: 'number',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },
  connection_type: {
    name: 'connection_type',
    column: 'connection_type',
    type: 'string',
    category: 'Device',
    tables: ['sessions', 'goals'],
  },

  // Session (sessions only)
  duration: {
    name: 'duration',
    column: 'duration',
    type: 'number',
    category: 'Session',
    tables: ['sessions'],
  },
  pageview_count: {
    name: 'pageview_count',
    column: 'pageview_count',
    type: 'number',
    category: 'Session',
    tables: ['sessions'],
  },
  sdk_version: {
    name: 'sdk_version',
    column: 'sdk_version',
    type: 'string',
    category: 'Session',
    tables: ['sessions'],
  },

  // Time (sessions and goals)
  year: {
    name: 'year',
    column: 'year',
    type: 'number',
    category: 'Time',
    tables: ['sessions', 'goals'],
  },
  month: {
    name: 'month',
    column: 'month',
    type: 'number',
    category: 'Time',
    tables: ['sessions', 'goals'],
  },
  day: {
    name: 'day',
    column: 'day',
    type: 'number',
    category: 'Time',
    tables: ['sessions', 'goals'],
  },
  day_of_week: {
    name: 'day_of_week',
    column: 'day_of_week',
    type: 'number',
    category: 'Time',
    tables: ['sessions', 'goals'],
  },
  week_number: {
    name: 'week_number',
    column: 'week_number',
    type: 'number',
    category: 'Time',
    tables: ['sessions', 'goals'],
  },
  hour: {
    name: 'hour',
    column: 'hour',
    type: 'number',
    category: 'Time',
    tables: ['sessions', 'goals'],
  },
  is_weekend: {
    name: 'is_weekend',
    column: 'is_weekend',
    type: 'boolean',
    category: 'Time',
    tables: ['sessions', 'goals'],
  },

  // Geo (sessions and goals)
  country: {
    name: 'country',
    column: 'country',
    type: 'string',
    category: 'Geo',
    tables: ['sessions', 'goals'],
  },
  region: {
    name: 'region',
    column: 'region',
    type: 'string',
    category: 'Geo',
    tables: ['sessions', 'goals'],
  },
  city: {
    name: 'city',
    column: 'city',
    type: 'string',
    category: 'Geo',
    tables: ['sessions', 'goals'],
  },
  latitude: {
    name: 'latitude',
    column: 'latitude',
    type: 'number',
    category: 'Geo',
    tables: ['sessions', 'goals'],
  },
  longitude: {
    name: 'longitude',
    column: 'longitude',
    type: 'number',
    category: 'Geo',
    tables: ['sessions', 'goals'],
  },
  language: {
    name: 'language',
    column: 'language',
    type: 'string',
    category: 'Geo',
    tables: ['sessions', 'goals'],
  },
  timezone: {
    name: 'timezone',
    column: 'timezone',
    type: 'string',
    category: 'Geo',
    tables: ['sessions', 'goals'],
  },

  // Custom Dimensions (sessions and goals)
  stm_1: {
    name: 'stm_1',
    column: 'stm_1',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_2: {
    name: 'stm_2',
    column: 'stm_2',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_3: {
    name: 'stm_3',
    column: 'stm_3',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_4: {
    name: 'stm_4',
    column: 'stm_4',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_5: {
    name: 'stm_5',
    column: 'stm_5',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_6: {
    name: 'stm_6',
    column: 'stm_6',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_7: {
    name: 'stm_7',
    column: 'stm_7',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_8: {
    name: 'stm_8',
    column: 'stm_8',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_9: {
    name: 'stm_9',
    column: 'stm_9',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },
  stm_10: {
    name: 'stm_10',
    column: 'stm_10',
    type: 'string',
    category: 'Custom',
    tables: ['sessions', 'goals'],
  },

  // Goal (goals table only)
  goal_name: {
    name: 'goal_name',
    column: 'goal_name',
    type: 'string',
    category: 'Goal',
    tables: ['goals'],
  },
  goal_path: {
    name: 'goal_path',
    column: 'path',
    type: 'string',
    category: 'Goal',
    tables: ['goals'],
  },

  // Téléphonie (goals only — phone_call events from the VoIP bridge).
  // The VoIP sync writes the attributed traffic source / direction / status
  // into the goal event's `properties` Map (api/src/voip/phone-call-event.ts).
  // These dimensions expose those Map keys so calls can be grouped/filtered
  // by source ("1 numéro = 1 source") directly in Explore.
  // Column is a ClickHouse Map accessor; the query-builder aliases it back to
  // the dimension name in the SELECT projection.
  phone_source: {
    name: 'phone_source',
    column: "properties['source']",
    type: 'string',
    category: 'Téléphonie',
    tables: ['goals'],
  },
  phone_direction: {
    name: 'phone_direction',
    column: "properties['direction']",
    type: 'string',
    category: 'Téléphonie',
    tables: ['goals'],
  },
  phone_status: {
    name: 'phone_status',
    column: "properties['status']",
    type: 'string',
    category: 'Téléphonie',
    tables: ['goals'],
  },

  // Goal properties (goals only — arbitrary keys of the goal event's
  // `properties` Map). Same ClickHouse Map-accessor mechanism as the phone_*
  // dimensions above: the query-builder aliases `properties['<key>']` back to
  // the dimension name in the SELECT, and the filter-builder binds the *value*
  // as a parameter ({fN:String}), so filtering/segmenting on these is safe.
  //
  // `variant` exposes `properties['variant']` (the A/B/C experience variant a
  // goal was fired under), enabling funnel segmentation / filtering by variant
  // without polluting an `stm_*` slot or duplicating `goal_name` per variant.
  //
  // EXTENSIBILITY: to expose another goal-property key as a filterable /
  // groupable dimension, add ONE entry here following this exact pattern
  // (`<dim>: { column: "properties['<key>']", type: 'string', tables: ['goals'] }`).
  // The key is HARD-CODED in `column` on purpose — it is interpolated into the
  // SQL (GROUP BY / SELECT / WHERE), so it must never be caller-controlled.
  // (No generic `goal_property` dimension with a runtime-supplied key: that
  // would interpolate an unbound, user-controlled Map key into SQL — an
  // injection vector — and would require reworking the query/filter builders.)
  //
  // LIMITATION: ClickHouse has no skip-index on a Map key, so filtering on
  // `properties['variant']` scans. Acceptable at demo scale; revisit (e.g. a
  // materialized column) if a high-traffic tenant relies on it.
  variant: {
    name: 'variant',
    column: "properties['variant']",
    type: 'string',
    category: 'Goal',
    tables: ['goals'],
  },

  // User
  user_id: {
    name: 'user_id',
    column: 'user_id',
    type: 'string',
    category: 'User',
    tables: ['sessions', 'pages', 'goals'],
  },
};
