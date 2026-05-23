export type FilterOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'is_empty' | 'is_not_empty' | 'regex'
export type FilterAction = 'set_value' | 'unset_value' | 'set_default_value'

export interface FilterCondition {
  field: string
  operator: FilterOperator
  value?: string // Optional for valueless operators (is_empty, is_not_empty)
}

export interface FilterOperation {
  dimension: string
  action: FilterAction
  value?: string // Required for set_value and set_default_value
}

export interface FilterDefinition {
  id: string
  name: string
  priority: number // 0-1000, higher = evaluated first
  order: number // UI display order (drag-drop)
  tags: string[] // e.g., ["channel", "marketing", "paid"]
  conditions: FilterCondition[] // All conditions must match (AND logic)
  operations: FilterOperation[] // Execute when conditions match
  enabled: boolean
  version: string // Hash for staleness detection
  createdAt: string
  updatedAt: string
}

export interface FilterWithStaleness extends FilterDefinition {
  staleSessionCount: number
  totalSessionCount: number
}

// Alias for backward compatibility
export type Filter = FilterDefinition

export interface CreateFilterInput {
  workspace_id: string
  name: string
  priority?: number // Default: 500
  tags?: string[] // Default: []
  conditions: FilterCondition[]
  operations: FilterOperation[]
  enabled?: boolean // Default: true
}

export interface UpdateFilterInput {
  workspace_id: string
  id: string
  name?: string
  priority?: number
  order?: number
  tags?: string[]
  conditions?: FilterCondition[]
  operations?: FilterOperation[]
  enabled?: boolean
}

export interface ReorderFiltersInput {
  workspace_id: string
  filter_ids: string[]
}

// Source fields that can be used in filter conditions
export const SOURCE_FIELDS = [
  // UTM
  { value: 'utm_source', label: 'UTM Source', category: 'UTM' },
  { value: 'utm_medium', label: 'UTM Medium', category: 'UTM' },
  { value: 'utm_campaign', label: 'UTM Campaign', category: 'UTM' },
  { value: 'utm_term', label: 'UTM Term', category: 'UTM' },
  { value: 'utm_content', label: 'UTM Content', category: 'UTM' },
  { value: 'utm_id', label: 'UTM ID', category: 'UTM' },
  { value: 'utm_id_from', label: 'UTM ID From', category: 'UTM' },
  // Traffic
  { value: 'referrer', label: 'Référent', category: 'Traffic' },
  { value: 'referrer_domain', label: 'Domaine référent', category: 'Traffic' },
  { value: 'referrer_path', label: 'Chemin référent', category: 'Traffic' },
  { value: 'is_direct', label: 'Direct ?', category: 'Traffic' },
  // Pages
  { value: 'landing_page', label: "Page d'entrée", category: 'Pages' },
  { value: 'landing_domain', label: "Domaine d'entrée", category: 'Pages' },
  { value: 'landing_path', label: "Chemin d'entrée", category: 'Pages' },
  { value: 'path', label: 'Chemin actuel', category: 'Pages' },
  // Device
  { value: 'device', label: 'Appareil', category: 'Device' },
  { value: 'browser', label: 'Navigateur', category: 'Device' },
  { value: 'browser_type', label: 'Type de navigateur', category: 'Device' },
  { value: 'os', label: "Système d'exploitation", category: 'Device' },
  { value: 'user_agent', label: 'User Agent', category: 'Device' },
  { value: 'connection_type', label: 'Type de connexion', category: 'Device' },
  // Geo
  { value: 'language', label: 'Langue', category: 'Geo' },
  { value: 'timezone', label: 'Fuseau horaire', category: 'Geo' },
] as const

// Dimensions that filters can write to
export const WRITABLE_DIMENSIONS = [
  // Channel classification
  { value: 'channel', label: 'Canal', category: 'Channel' },
  { value: 'channel_group', label: 'Groupe de canaux', category: 'Channel' },
  // Custom dimension slots
  { value: 'stm_1', label: 'Dimension personnalisée 1', category: 'Custom' },
  { value: 'stm_2', label: 'Dimension personnalisée 2', category: 'Custom' },
  { value: 'stm_3', label: 'Dimension personnalisée 3', category: 'Custom' },
  { value: 'stm_4', label: 'Dimension personnalisée 4', category: 'Custom' },
  { value: 'stm_5', label: 'Dimension personnalisée 5', category: 'Custom' },
  { value: 'stm_6', label: 'Dimension personnalisée 6', category: 'Custom' },
  { value: 'stm_7', label: 'Dimension personnalisée 7', category: 'Custom' },
  { value: 'stm_8', label: 'Dimension personnalisée 8', category: 'Custom' },
  { value: 'stm_9', label: 'Dimension personnalisée 9', category: 'Custom' },
  { value: 'stm_10', label: 'Dimension personnalisée 10', category: 'Custom' },
  // UTM fields
  { value: 'utm_source', label: 'UTM Source', category: 'UTM' },
  { value: 'utm_medium', label: 'UTM Medium', category: 'UTM' },
  { value: 'utm_campaign', label: 'UTM Campaign', category: 'UTM' },
  { value: 'utm_term', label: 'UTM Term', category: 'UTM' },
  { value: 'utm_content', label: 'UTM Content', category: 'UTM' },
  // Traffic fields
  { value: 'referrer_domain', label: 'Domaine référent', category: 'Traffic' },
  { value: 'is_direct', label: 'Direct ?', category: 'Traffic' },
] as const

export const OPERATORS = [
  { value: 'equals' as const, label: 'égal à' },
  { value: 'not_equals' as const, label: 'différent de' },
  { value: 'contains' as const, label: 'contient' },
  { value: 'not_contains' as const, label: 'ne contient pas' },
  { value: 'is_empty' as const, label: 'est vide' },
  { value: 'is_not_empty' as const, label: 'non vide' },
  { value: 'regex' as const, label: 'correspond à la regex' },
] as const

// Operators that don't require a value
export const VALUELESS_OPERATORS: FilterOperator[] = ['is_empty', 'is_not_empty']

export const FILTER_ACTIONS = [
  { value: 'set_value' as const, label: 'Définir la valeur', description: 'Toujours définir à la valeur spécifiée' },
  { value: 'unset_value' as const, label: 'Effacer la valeur', description: 'Définir à null/vide' },
  { value: 'set_default_value' as const, label: 'Valeur par défaut', description: 'Définir uniquement si actuellement null' },
] as const

// Common filter tags for UI suggestions
export const SUGGESTED_TAGS = [
  'channel',
  'channel group',
  'marketing',
  'paid',
  'organic',
  'social',
  'direct',
  'referral',
  'email',
  'content',
  'page category',
  'funnel',
] as const

// Backfill types
export type BackfillTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface BackfillTaskProgress {
  id: string
  status: BackfillTaskStatus
  progress_percent: number
  sessions: { processed: number; total: number }
  events: { processed: number; total: number }
  current_chunk: string | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  estimated_remaining_seconds: number | null
  filter_version: string
}

export interface BackfillSummary {
  needsBackfill: boolean
  currentFilterVersion: string
  lastCompletedFilterVersion: string | null
  activeTask: BackfillTaskProgress | null
}

export interface StartBackfillInput {
  workspace_id: string
  lookback_days: number
}
