import { FilterDefinition } from '../../filters/entities/filter.entity';
import { Integration } from './integration.entity';

export type WorkspaceStatus = 'initializing' | 'active' | 'inactive' | 'error';

/**
 * Custom dimension labels map.
 * Maps slot number (as string) to label.
 * Example: { "1": "Channel Group", "2": "Channel" }
 */
export type CustomDimensionLabels = Record<string, string>;

/**
 * Annotation for marking significant dates on charts.
 */
export interface Annotation {
  id: string;
  date: string; // ISO date string (YYYY-MM-DD)
  time: string; // HH:mm format (e.g., '14:30')
  timezone: string; // IANA timezone (e.g., 'America/New_York')
  title: string;
  description?: string;
  color?: string; // Hex color, defaults to '#7763f1'
}

/**
 * SMTP settings for workspace email configuration.
 * TLS mode is auto-detected based on port: 465 = implicit TLS, others = STARTTLS
 */
export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  username?: string;
  password_encrypted?: string;
  from_name: string;
  from_email: string;
}

/**
 * Per-client visual branding (white-label). `logo_url` + `name` live as
 * top-level workspace columns; `color` is the accent (hex `#rrggbb`) applied to
 * the console primary color. Empty/undefined → the default Veridian branding.
 */
export interface WorkspaceBranding {
  /** Accent color, hex `#rrggbb`. Default Veridian `#7763f1` when unset. */
  color?: string;
}

/**
 * Which optional feature modules a workspace has subscribed to. Drives the
 * VISIBILITY of the corresponding Settings tabs in the console (masqué, jamais
 * grisé — cf vision pricing). Absent flag → feature SHOWN (back-compat: every
 * existing workspace keeps seeing every tab until features are declared).
 */
export interface WorkspaceFeatures {
  /** Téléphonie / VoIP settings tab + Calls. */
  voip?: boolean;
  /** Search Console settings tab. */
  gsc?: boolean;
  /** CRM connectors (Twenty) settings tab. */
  connectors?: boolean;
}

/**
 * One custom dashboard widget = a stored DESCRIPTION of an analytics group-by,
 * compiled into the canonical AnalyticsQueryDto and resolved by the native
 * query-builder at read time (VAGUE 2 — dashboard customisable "comme Twenty").
 * The 8 native widgets stay hardcoded; this only ADDS workspace-defined widgets.
 * Persisted in the `settings` JSON → zero migration. Always validated before
 * persist (whitelist + kind coherence + unique id) — see dashboard-widget.validator.
 */
export interface DashboardWidget {
  /** Unique slug id within the layout; referenced by `order`. */
  id: string;
  /** Render kind. */
  kind: 'metric_card' | 'time_series' | 'dimension_table';
  /** Display title. */
  title: string;
  /** Widget-safe metric key (whitelist). */
  metric: string;
  /** Analytics table; default 'sessions'. */
  table?: 'sessions' | 'pages' | 'goals';
  /** Widget-safe dimension key (required for dimension_table). */
  dimension?: string;
  /** Time bucket (required for time_series). */
  granularity?: 'hour' | 'day' | 'week' | 'month' | 'year';
  /** Optional filters on widget-safe dimensions. */
  filters?: Array<{
    dimension: string;
    operator: string;
    values?: (string | number | null)[];
  }>;
  /** Row cap for dimension_table (default 10). */
  limit?: number;
}

/**
 * Per-client dashboard layout. The native staminads dashboard reads this to
 * REORDER and HIDE its existing widgets (no custom Veridian component — vision
 * 2026-05-23). Unknown/absent → the default native order, all widgets shown.
 *
 * `widgets[]` (VAGUE 2) ADDS workspace-defined custom widgets on top of the
 * native grid. `order` may reference a native widget key OR a custom widget id.
 */
export interface DashboardLayout {
  /** Native widget keys to hide (e.g. 'campaigns', 'countries', 'devices'). */
  hidden_widgets?: string[];
  /** Ordered keys (native widget key OR custom widget id); unlisted keep default order. */
  order?: string[];
  /** Custom workspace-defined widgets (config group-by). */
  widgets?: DashboardWidget[];
}

/**
 * One CRM milestone rule (N4 generic engine). Declares that a tracked event
 * (a `goal_name`, or an `/audit/`-style screen_view) maps to a Twenty timeline
 * activity. Replaces the hardcoded CTA_GOALS/RDV_GOALS/… Sets so ANY industry
 * can wire its own funnel without a code change.
 */
export interface CrmGoalMapping {
  /** Raw event match. `goal:<name>` (a goal event) or `screen_view:<pathPrefix>`. */
  match: string;
  /** Twenty timeline activity `name` to emit (free-form, e.g. 'achat', 'reservation'). */
  timeline_name: string;
  /** Optional scroll threshold (%) for screen_view rules; emit only when reached. */
  min_scroll?: number;
}

/**
 * Configurable analytics→CRM semantics for ONE workspace (N4 + S4). Makes the
 * Twenty connector a generic, config-driven engine instead of a prospection-only
 * switch. Absent → the legacy built-in prospection mapping is used (back-compat).
 */
export interface WorkspaceCrmMapping {
  /**
   * How to resolve the target Person from the event `user_id`:
   *   - 'auto'  : '@' → email, else slug (legacy behaviour, default)
   *   - 'email' : always treat user_id as an email
   *   - 'field' : user_id is an opaque id (e.g. Supabase UUID) → resolve the
   *               Person on a custom Twenty field named `identity_field`.
   */
  identity_resolver?: 'auto' | 'email' | 'field';
  /** Twenty custom field to match when identity_resolver = 'field' (e.g. 'supabaseId'). */
  identity_field?: string;
  /**
   * Ordered milestone rules. When present, these REPLACE the built-in Sets
   * entirely (the workspace owns its full CRM vocabulary). Empty/absent → the
   * legacy built-in prospection mapping applies.
   */
  goals?: CrmGoalMapping[];
  /**
   * When true, also emit a milestone for the native `phone_call` goal (S4),
   * carrying `phone_source` + normalized `acquisition_source` in properties.
   * Defaults to true (calls are a first-class CRM signal for every industry).
   */
  map_phone_calls?: boolean;
  /** Timeline activity name for a phone_call (S4). Default 'appel'. */
  phone_call_timeline_name?: string;
}

/**
 * One step of a persisted, named funnel (VAGUE 2). A step = a tracked
 * `goal_name` (or any event `name`) the unit must reach, IN ORDER. The optional
 * `label` is the human caption shown in reports; default = `goal_name`.
 *
 * This mirrors the ad-hoc `FunnelStepDto` exactly (same shape) — the only
 * difference is that a NamedFunnel's steps are STORED per workspace instead of
 * being passed on every call, so each client owns its own conversion funnel
 * (the tracker varies: phone, form, purchase, signup…).
 */
export interface FunnelStepConfig {
  /** The `goal_name` / event `name` this step matches. */
  goal_name: string;
  /** Human caption shown in reports. Default = goal_name. */
  label?: string;
}

/**
 * A named, persisted funnel definition for ONE workspace (VAGUE 2
 * customisation). Generalises the data-driven `crm_mapping.goals[]` pattern to
 * the sales funnel: instead of passing `steps` on every `analytics.funnel` call,
 * a client DEFINES its funnels once (e.g. a vitrine's "rdv" funnel =
 * appointment_click → rdv_booked → form_submission), then EXECUTES them by name.
 *
 * Stored in the `settings` JSON blob (zero migration). The `default_unit` /
 * `default_window_seconds` let a funnel carry its natural execution defaults
 * (a phone funnel spans days → visitor unit; a checkout funnel = one session)
 * while still being overridable at run time.
 */
export interface NamedFunnel {
  /** Stable machine name used to execute the funnel (`funnels.run`). Unique per workspace. */
  name: string;
  /** Human title shown in the UI. Default = name. */
  label?: string;
  /** Ordered steps (2..8). The array order IS the funnel sequence. */
  steps: FunnelStepConfig[];
  /**
   * Natural progression unit for THIS funnel:
   *   - 'session' : one session_id must cross all steps (e.g. checkout) ;
   *   - 'visitor' : one visitor_id crosses steps cross-session (e.g. a phone
   *                 funnel spanning several visits).
   * Default 'session' at run time when unset.
   */
  default_unit?: 'session' | 'visitor';
  /**
   * Natural windowFunnel window (seconds) for THIS funnel. Default at run time =
   * the full requested date span when unset (steps may span the whole period).
   */
  default_window_seconds?: number;
}

/**
 * Workspace settings stored as JSON in the settings column.
 */
export interface WorkspaceSettings {
  // TimeScore configuration
  timescore_reference: number;
  bounce_threshold: number;

  // Custom dimensions
  custom_dimensions?: CustomDimensionLabels | null;

  // Filters
  filters?: FilterDefinition[];

  // Integrations
  integrations?: Integration[];

  // Geo settings
  geo_enabled: boolean;
  geo_store_city: boolean;
  geo_store_region: boolean;
  geo_coordinates_precision: number;

  // Annotations
  annotations?: Annotation[];

  // SMTP settings
  smtp?: SmtpSettings;

  // Domain restriction (optional)
  allowed_domains?: string[];

  /**
   * Nom du paramètre d'URL portant le code de parrainage interne (`?ref=CODE`),
   * parsé à l'ingestion depuis `landing_page` pour dériver le canal `referral`
   * et stocker le code parrain dans `utm_content` (S6 Lot B). Configurable par
   * workspace car le param varie d'un client à l'autre.
   *
   *   - absent / undefined → défaut `ref`
   *   - chaîne non vide     → ce param est utilisé (ex. `parrain`, `aff`)
   *   - '' / null explicite → DÉSACTIVÉ : on ne parse aucun code de parrainage
   *                           (un client peut couper la feature)
   *
   * Stocké dans le JSON `settings` (pas une colonne) → zéro migration.
   */
  referral_param?: string | null;

  // ─── White-label / multi-industrie configuration (pilotable M2M) ───────
  /** Per-client visual branding (accent color). Logo/name = top-level columns. */
  branding?: WorkspaceBranding;
  /** Subscribed feature modules → drive Settings tab visibility. */
  features?: WorkspaceFeatures;
  /** Native dashboard widget order/visibility per client. */
  dashboard_layout?: DashboardLayout;
  /** Configurable analytics→CRM semantics (N4 + S4). */
  crm_mapping?: WorkspaceCrmMapping;
  /**
   * Per-workspace named funnels (VAGUE 2 customisation). Each client defines its
   * own conversion funnels (steps = goals/events, tracker adapted: phone, form,
   * purchase, signup…), executed by name via `funnels.run`. Absent → the
   * workspace has no persisted funnel; the caller must pass ad-hoc `steps`.
   */
  funnels?: NamedFunnel[];
}

/**
 * Derive the default `allowed_domains` entry from a workspace `website`.
 *
 * Security rationale (ticket 2026-06-23-ingest-allowed-domains-vide): a fresh
 * workspace should NOT accept tracking from any Origin by default. The client's
 * own site is already known at provisioning time (`website`), so we seed
 * `allowed_domains` with a wildcard on its apex domain — covering `apex`,
 * `www.apex` and legitimate sub-domains while rejecting unrelated origins.
 *
 * Returns `[]` when the website cannot be parsed (caller keeps "allow all"
 * legacy behaviour rather than locking the client out).
 */
export function deriveAllowedDomains(website?: string): string[] {
  if (!website) return [];
  let host: string;
  try {
    // Tolerate values stored without a scheme (e.g. "client.fr").
    const url = new URL(
      /^https?:\/\//i.test(website) ? website : `https://${website}`,
    );
    host = url.hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host) return [];
  // Collapse a leading www. so the wildcard covers both apex and www.
  const apex = host.replace(/^www\./, '');
  return [`*.${apex}`];
}

/**
 * Default settings for new workspaces.
 */
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  timescore_reference: 60,
  bounce_threshold: 10,
  custom_dimensions: {},
  filters: [],
  integrations: [],
  geo_enabled: true,
  geo_store_city: true,
  geo_store_region: true,
  geo_coordinates_precision: 2,
  annotations: [],
};

/**
 * Workspace entity - represents the full workspace.
 * Top-level columns remain for quick access/querying.
 * Configurable settings are stored in the `settings` JSON field.
 */
export interface Workspace {
  id: string;
  name: string;
  website: string;
  timezone: string;
  currency: string;
  logo_url?: string;
  status: WorkspaceStatus;
  created_at: string;
  updated_at: string;
  settings: WorkspaceSettings;
}
