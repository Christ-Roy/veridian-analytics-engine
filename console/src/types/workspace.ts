export type WorkspaceStatus = 'initializing' | 'active' | 'inactive' | 'error'

/**
 * Custom dimension labels map.
 * Maps slot number (as string) to label.
 * Example: { "1": "Channel Group", "2": "Channel" }
 */
export type CustomDimensionLabels = Record<string, string>

export interface WorkspaceIntegrationSettings {
  api_key_encrypted: string
  model: string
  max_tokens?: number
  temperature?: number
}

export interface WorkspaceIntegrationLimits {
  max_requests_per_hour?: number
  max_tokens_per_day?: number
}

export interface WorkspaceIntegration {
  id: string
  type: 'anthropic'
  enabled: boolean
  created_at: string
  updated_at: string
  settings: WorkspaceIntegrationSettings
  limits?: WorkspaceIntegrationLimits
}

/**
 * Annotation for marking significant dates on charts.
 */
export interface Annotation {
  id: string
  date: string // ISO date string (YYYY-MM-DD)
  time: string // HH:mm format (e.g., '14:30')
  timezone: string // IANA timezone (e.g., 'America/New_York')
  title: string
  description?: string
  color?: string // Hex color, defaults to '#7763f1'
}

/** Per-client accent color (white-label, N1). */
export interface WorkspaceBranding {
  color?: string
}

/** Subscribed feature modules → Settings tab visibility (N2). */
export interface WorkspaceFeatures {
  voip?: boolean
  gsc?: boolean
  connectors?: boolean
}

/**
 * Un widget custom = une DESCRIPTION d'un group-by analytics, persistée dans
 * `settings.dashboard_layout.widgets[]` (zéro migration) et résolue par le
 * query-builder natif. Shape calqué sur le contrat backend (VAGUE 2,
 * api/.../dto/customization.dto.ts WidgetConfigDto). Validé STRICTEMENT à la
 * persistance côté engine (whitelist widget-safe + cohérence kind + id unique) :
 * le front reçoit donc toujours un widget déjà sain.
 */
export interface DashboardWidget {
  /** Slug unique dans le layout ; référencé par `order`. */
  id: string
  /** Type de rendu. */
  kind: 'metric_card' | 'time_series' | 'dimension_table'
  /** Titre affiché. */
  title: string
  /** Métrique widget-safe (whitelist). */
  metric: string
  /** Table analytics ; défaut 'sessions'. */
  table?: 'sessions' | 'pages' | 'goals'
  /** Dimension widget-safe (obligatoire pour dimension_table). */
  dimension?: string
  /** Granularité temporelle (obligatoire pour time_series). */
  granularity?: 'hour' | 'day' | 'week' | 'month' | 'year'
  /** Filtres optionnels sur des dimensions widget-safe. */
  filters?: Array<{
    dimension: string
    operator: string
    values?: (string | number | null)[]
  }>
  /** Plafond de lignes pour dimension_table (défaut 10). */
  limit?: number
}

/**
 * Layout dashboard par client (N3 + VAGUE 2). Le dashboard natif staminads lit
 * ceci pour RÉORDONNER / MASQUER ses widgets natifs ET pour AJOUTER des widgets
 * custom définis par workspace. `order` peut référencer une clé de widget natif
 * OU un `widget.id` custom.
 */
export interface DashboardLayout {
  hidden_widgets?: string[]
  order?: string[]
  /** Widgets custom définis par workspace (config group-by). */
  widgets?: DashboardWidget[]
}

/**
 * Workspace settings stored as JSON.
 */
export interface WorkspaceSettings {
  timescore_reference: number
  bounce_threshold: number
  custom_dimensions?: CustomDimensionLabels | null
  integrations?: WorkspaceIntegration[]
  geo_enabled: boolean
  geo_store_city: boolean
  geo_store_region: boolean
  geo_coordinates_precision: number
  annotations?: Annotation[]
  allowed_domains?: string[]
  // White-label / multi-industrie (pilotable M2M)
  branding?: WorkspaceBranding
  features?: WorkspaceFeatures
  dashboard_layout?: DashboardLayout
}

/**
 * Workspace entity with settings nested.
 */
export interface Workspace {
  id: string
  name: string
  website: string
  timezone: string
  currency: string
  logo_url?: string
  created_at: string
  updated_at: string
  status: WorkspaceStatus
  settings: WorkspaceSettings
}

export interface CreateWorkspaceInput {
  id: string
  name: string
  website: string
  timezone: string
  currency: string
  logo_url?: string
  settings?: Partial<WorkspaceSettings>
}

export interface UpdateWorkspaceInput {
  id: string
  name?: string
  website?: string
  timezone?: string
  currency?: string
  logo_url?: string
  status?: WorkspaceStatus
  settings?: Partial<WorkspaceSettings>
}
