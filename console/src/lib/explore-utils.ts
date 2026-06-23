import type { Filter } from '../types/analytics'
import type { ExploreRow, ChildrenQueryConfig, DimensionsByCategory, DimensionInfo } from '../types/explore'

/**
 * Libellé unique affiché pour une valeur de dimension vide/nulle. Source
 * unique pour éviter le mélange « (empty) » / « (non défini) » entre écrans.
 */
export const EMPTY_VALUE_LABEL = '(vide)'

/**
 * Ordre d'affichage canonique des catégories de dimensions, partagé par les
 * 3 sélecteurs (DimensionSelector, BreakdownModal, ExploreFilterBuilder) pour
 * un tri identique partout. Les catégories absentes de cette liste tombent en
 * fin via tri alphabétique (cf. sortCategoriesByOrder). Les noms correspondent
 * aux `category` du backend (api/src/analytics/constants/dimensions.ts).
 * « Téléphonie » (source d'événements métier Veridian) est placée juste après
 * les pages pour ne pas tomber orpheline en fin de liste.
 */
export const CATEGORY_ORDER = [
  'Traffic',
  'UTM',
  'Channel',
  'Session Pages',
  'Page',
  'Téléphonie',
  'Goal',
  'Session',
  'Device',
  'Geo',
  'Time',
  'User',
  'Custom',
] as const

/**
 * Libellés FR des catégories de dimensions (en-têtes de groupe dans les
 * sélecteurs). Source unique pour éviter le mélange EN/FR et les divergences
 * entre écrans (ex. « Custom Dimensions » vs « Dimensions personnalisées »).
 */
export const CATEGORY_LABELS_FR: Record<string, string> = {
  Traffic: 'Trafic',
  UTM: 'UTM',
  Channel: 'Canaux',
  'Session Pages': 'Pages de session',
  Page: 'Pages',
  Téléphonie: 'Téléphonie',
  Goal: 'Objectifs',
  Session: 'Session',
  Device: 'Appareils',
  Geo: 'Géographie',
  Time: 'Temps',
  User: 'Utilisateur',
  Custom: 'Dimensions personnalisées',
}

/**
 * Libellé FR d'affichage d'une catégorie (fallback : le nom brut).
 */
export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS_FR[category] ?? category
}

/**
 * Trie une liste de catégories selon CATEGORY_ORDER. Les catégories hors liste
 * sont placées en fin, triées alphabétiquement entre elles.
 */
export function sortCategoriesByOrder(categories: string[]): string[] {
  const order = CATEGORY_ORDER as readonly string[]
  return [...categories].sort((a, b) => {
    const aIndex = order.indexOf(a)
    const bIndex = order.indexOf(b)
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b)
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  })
}

/**
 * Libellés FR explicites des dimensions, consultés en priorité par
 * getDimensionLabel avant le fallback Title Case. Couvre les dimensions
 * exposées dans l'UI (trafic, UTM, pages, device, geo, time, goal + phone_*).
 * Les dimensions custom `stm_*` gardent leur traitement dédié (libellé
 * workspace ou numéro de slot).
 */
const DIMENSION_LABELS_FR: Record<string, string> = {
  // Trafic
  referrer: 'Référent',
  referrer_domain: 'Domaine référent',
  referrer_path: 'Chemin référent',
  is_direct: 'Accès direct',
  // UTM
  utm_source: 'Source UTM',
  utm_medium: 'Support UTM',
  utm_campaign: 'Campagne UTM',
  utm_term: 'Mot-clé UTM',
  utm_content: 'Contenu UTM',
  // Canaux
  channel: 'Canal',
  channel_group: 'Groupe de canaux',
  // Pages de session
  landing_page: "Page d'entrée",
  landing_domain: "Domaine d'entrée",
  landing_path: "Chemin d'entrée",
  exit_path: 'Chemin de sortie',
  // Pages
  page_path: 'Chemin de page',
  page_number: 'Numéro de page',
  is_landing_page: "Page d'entrée",
  is_exit_page: 'Page de sortie',
  page_entry_type: "Type d'entrée de page",
  // Téléphonie
  phone_source: "Source d'appel",
  phone_direction: "Sens d'appel",
  phone_status: "Statut d'appel",
  // Appareils
  device: 'Appareil',
  browser: 'Navigateur',
  browser_type: 'Type de navigateur',
  os: "Système d'exploitation",
  screen_width: "Largeur d'écran",
  screen_height: "Hauteur d'écran",
  viewport_width: 'Largeur du viewport',
  viewport_height: 'Hauteur du viewport',
  connection_type: 'Type de connexion',
  // Session
  duration: 'Durée',
  pageview_count: 'Nombre de pages vues',
  sdk_version: 'Version du SDK',
  // Temps
  year: 'Année',
  month: 'Mois',
  day: 'Jour',
  day_of_week: 'Jour de la semaine',
  week_number: 'Numéro de semaine',
  hour: 'Heure',
  is_weekend: 'Week-end',
  // Géographie
  country: 'Pays',
  region: 'Région',
  city: 'Ville',
  latitude: 'Latitude',
  longitude: 'Longitude',
  language: 'Langue',
  timezone: 'Fuseau horaire',
  // Objectifs
  goal_name: "Nom de l'objectif",
  goal_path: "Chemin de l'objectif",
  // Utilisateur
  user_id: 'Identifiant utilisateur',
}

/**
 * Example values for each dimension to show in tooltips
 */
const DIMENSION_EXAMPLES: Record<string, [string, string]> = {
  // Traffic
  referrer: ['https://google.com/search?q=...', 'https://twitter.com/status/123'],
  referrer_domain: ['google.com', 'facebook.com'],
  referrer_path: ['/search', '/user/profile'],
  is_direct: ['true', 'false'],

  // UTM
  utm_source: ['google', 'newsletter'],
  utm_medium: ['cpc', 'email'],
  utm_campaign: ['black_friday_2024', 'spring_sale'],
  utm_term: ['running shoes', 'best laptops'],
  utm_content: ['banner_top', 'sidebar_cta'],

  // Channel
  channel: ['organic_search', 'paid_search'],
  channel_group: ['seo', 'ads'],

  // Pages
  landing_page: ['https://example.com/products', 'https://example.com/blog'],
  landing_domain: ['example.com', 'shop.example.com'],
  landing_path: ['/products', '/blog/how-to-guide'],
  entry_page: ['/', '/pricing'],
  exit_page: ['/checkout', '/contact'],

  // Device
  device: ['desktop', 'mobile'],
  browser: ['Chrome', 'Safari'],
  browser_type: ['browser', 'webview'],
  os: ['Windows', 'macOS'],
  screen_width: ['1920', '1440'],
  screen_height: ['1080', '900'],
  viewport_width: ['1920', '375'],
  viewport_height: ['937', '667'],
  connection_type: ['4g', 'wifi'],

  // Time
  year: ['2024', '2025'],
  month: ['1', '12'],
  day: ['1', '31'],
  day_of_week: ['1 (Mon)', '5 (Fri)'],
  week_number: ['1', '52'],
  hour: ['9', '18'],
  is_weekend: ['true', 'false'],

  // Geo
  country: ['US', 'GB'],
  region: ['California', 'England'],
  city: ['New York', 'London'],
  language: ['en-US', 'fr-FR'],
  timezone: ['America/New_York', 'Europe/Paris'],
}

/**
 * Get example values for a dimension
 */
export function getDimensionExamples(dimensionName: string): [string, string] | null {
  return DIMENSION_EXAMPLES[dimensionName] || null
}

/**
 * Generate a unique key for a row based on its dimension path.
 * Includes an optional index to ensure uniqueness for empty values.
 */
export function generateRowKey(
  parentKey: string | null,
  dimensionValue: unknown,
  index?: number,
): string {
  const isEmpty = dimensionValue === null || dimensionValue === '' || dimensionValue === undefined
  // For empty values, include an index to ensure uniqueness
  const valueStr = isEmpty
    ? `[empty${index !== undefined ? `:${index}` : ''}]`
    : String(dimensionValue)
  return parentKey ? `${parentKey}:${valueStr}` : valueStr
}

/**
 * Core function: Calculate dimensions and filters for fetching children
 * When a user expands a row, this determines what query to make
 */
export function calculateChildrenDimensionsAndFilters(
  parentRecord: ExploreRow,
  dimensions: string[],
  baseFilters: Filter[],
): ChildrenQueryConfig {
  // Determine current level - if parentRecord has parentDimensionIndex of -1, this is root level
  const currentDimensionIndex = parentRecord.parentDimensionIndex + 1

  // Fetch dimensions up to current level + 1 (to get children)
  // For initial load (parentDimensionIndex = -1), we fetch just the first dimension
  const dimensionsToFetch = dimensions.slice(0, currentDimensionIndex + 1)

  // Build filters: base filters + one filter per parent dimension
  const drillDownFilters: Filter[] = dimensions
    .slice(0, currentDimensionIndex)
    .map((dimension) => {
      const value = parentRecord[dimension]
      // Handle empty/null values with isEmpty operator
      if (value === null || value === '' || value === undefined) {
        return {
          dimension,
          operator: 'isEmpty' as const,
          values: [],
        }
      }
      return {
        dimension,
        operator: 'equals' as const,
        values: [value as string | number],
      }
    })

  return {
    currentDimensionIndex,
    dimensionsToFetch,
    filters: [...baseFilters, ...drillDownFilters],
  }
}

/**
 * Transform API response rows into ExploreRow format
 */
export function transformApiRowsToExploreRows(
  apiRows: Record<string, unknown>[],
  dimensions: string[],
  parentDimensionIndex: number,
  parentKey: string | null,
  hasPreviousPeriod: boolean,
): ExploreRow[] {
  // The current dimension is at parentDimensionIndex (0-indexed after fetch)
  const currentDimensionIndex = parentDimensionIndex
  const currentDimension = dimensions[currentDimensionIndex]

  if (!currentDimension) {
    return []
  }

  return apiRows.map((row, index) => {
    const dimValue = row[currentDimension]
    const key = generateRowKey(parentKey, dimValue, index)

    // Store ALL dimension values from the API response (including parent dimensions)
    // This is needed for building correct filters when expanding deeper levels
    const dimensionValues: Record<string, unknown> = {}
    for (let i = 0; i <= currentDimensionIndex; i++) {
      const dim = dimensions[i]
      if (dim && row[dim] !== undefined) {
        dimensionValues[dim] = row[dim]
      }
    }

    const exploreRow: ExploreRow = {
      key,
      parentDimensionIndex: currentDimensionIndex,
      childrenLoaded: false,
      ...dimensionValues,
      // Current period metrics
      unique_visitors: (row.unique_visitors as number) ?? 0,
      sessions: (row.sessions as number) ?? 0,
      median_duration: (row.median_duration as number) ?? 0,
      bounce_rate: (row.bounce_rate as number) ?? 0,
      median_scroll: (row.median_scroll as number) ?? 0,
    }

    // Add previous period metrics if available
    if (hasPreviousPeriod) {
      exploreRow.unique_visitors_prev = row.unique_visitors_prev as number | undefined
      exploreRow.sessions_prev = row.sessions_prev as number | undefined
      exploreRow.median_duration_prev = row.median_duration_prev as number | undefined
      exploreRow.bounce_rate_prev = row.bounce_rate_prev as number | undefined
      exploreRow.median_scroll_prev = row.median_scroll_prev as number | undefined

      // Calculate change percentages
      if (exploreRow.unique_visitors_prev !== undefined && exploreRow.unique_visitors_prev > 0) {
        exploreRow.unique_visitors_change = ((exploreRow.unique_visitors - exploreRow.unique_visitors_prev) / exploreRow.unique_visitors_prev) * 100
      }
      if (exploreRow.sessions_prev !== undefined && exploreRow.sessions_prev > 0) {
        exploreRow.sessions_change = ((exploreRow.sessions - exploreRow.sessions_prev) / exploreRow.sessions_prev) * 100
      }
      if (exploreRow.median_duration_prev !== undefined && exploreRow.median_duration_prev > 0) {
        exploreRow.median_duration_change = ((exploreRow.median_duration - exploreRow.median_duration_prev) / exploreRow.median_duration_prev) * 100
      }
      if (exploreRow.bounce_rate_prev !== undefined && exploreRow.bounce_rate_prev > 0) {
        exploreRow.bounce_rate_change = ((exploreRow.bounce_rate - exploreRow.bounce_rate_prev) / exploreRow.bounce_rate_prev) * 100
      }
      if (exploreRow.median_scroll_prev !== undefined && exploreRow.median_scroll_prev > 0) {
        exploreRow.median_scroll_change = ((exploreRow.median_scroll - exploreRow.median_scroll_prev) / exploreRow.median_scroll_prev) * 100
      }
    }

    return exploreRow
  })
}

/**
 * Merge current and previous period data from API response
 */
export function mergeComparisonData(
  current: Record<string, unknown>[],
  previous: Record<string, unknown>[],
  currentDimension: string,
): Record<string, unknown>[] {
  return current.map((row) => {
    const dimValue = row[currentDimension]
    const prevRow = previous?.find((p) => p[currentDimension] === dimValue)
    return {
      ...row,
      unique_visitors_prev: prevRow?.unique_visitors,
      sessions_prev: prevRow?.sessions,
      median_duration_prev: prevRow?.median_duration,
      bounce_rate_prev: prevRow?.bounce_rate,
      median_scroll_prev: prevRow?.median_scroll,
    }
  })
}

/**
 * Check if a row can be expanded (has more dimensions below)
 */
export function canExpandRow(
  row: ExploreRow,
  dimensions: string[],
): boolean {
  return row.parentDimensionIndex < dimensions.length - 1
}

/**
 * Insert children into the tree structure
 */
export function insertChildrenIntoTree(
  rows: ExploreRow[],
  parentKey: string,
  children: ExploreRow[],
  childrenFilteredByMinSessions?: boolean,
): ExploreRow[] {
  return rows.map((row) => {
    if (row.key === parentKey) {
      return {
        ...row,
        childrenLoaded: true,
        children,
        isLoading: false,
        childrenFilteredByMinSessions,
      }
    }
    if (row.children) {
      return {
        ...row,
        children: insertChildrenIntoTree(row.children, parentKey, children, childrenFilteredByMinSessions),
      }
    }
    return row
  })
}

/**
 * Mark a row as loading
 */
export function setRowLoading(
  rows: ExploreRow[],
  rowKey: string,
  isLoading: boolean,
): ExploreRow[] {
  return rows.map((row) => {
    if (row.key === rowKey) {
      return { ...row, isLoading }
    }
    if (row.children) {
      return {
        ...row,
        children: setRowLoading(row.children, rowKey, isLoading),
      }
    }
    return row
  })
}

/**
 * Calculate heat map color based on median duration value
 * Two-tone gradient with reference as pivot:
 * - Below reference: white → green
 * - Above reference: green → cyan (to spot exceptional sources)
 */
export function getHeatMapColor(
  value: number,
  bestValue: number,
  referenceValue?: number,
): string {
  if (!bestValue || value <= 0) return 'transparent'

  const reference = referenceValue ?? bestValue
  const effectiveMax = Math.max(bestValue, reference) // Ceiling must be >= reference

  if (value <= reference) {
    // Below/at reference: white → green
    const ratio = value / reference
    const lightness = 100 - (ratio * 40) // 100% → 60%
    return `hsl(142, 70%, ${lightness}%)`
  } else {
    // Above reference: green → cyan
    const headroom = effectiveMax - reference
    if (headroom <= 0) {
      // Edge case: max == reference, full cyan immediately
      return `hsl(180, 70%, 50%)`
    }
    const aboveRatio = Math.min((value - reference) / headroom, 1)
    const hue = 142 + (aboveRatio * 38) // 142 → 180 (cyan)
    const lightness = 60 - (aboveRatio * 10) // 60% → 50%
    return `hsl(${hue}, 70%, ${lightness}%)`
  }
}

/**
 * Get bullet style for heat map indicator
 */
export function getHeatMapStyle(
  value: number,
  bestValue: number,
  referenceValue?: number,
): React.CSSProperties {
  const color = getHeatMapColor(value, bestValue, referenceValue)
  return {
    backgroundColor: color,
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  }
}

/**
 * Group dimensions by category for the selector UI
 */
export function groupDimensionsByCategory(
  dimensions: Record<string, DimensionInfo>,
): DimensionsByCategory {
  const grouped: DimensionsByCategory = {}

  for (const [name, info] of Object.entries(dimensions)) {
    const category = info.category || 'Other'
    if (!grouped[category]) {
      grouped[category] = []
    }
    grouped[category].push({ ...info, name })
  }

  // Sort dimensions within each category by name (with natural sorting for numbers)
  for (const category of Object.keys(grouped)) {
    grouped[category].sort((a, b) => {
      // Use natural sorting for custom dimensions (stm_1, stm_2, ..., stm_10)
      const aMatch = a.name.match(/^stm_(\d+)$/)
      const bMatch = b.name.match(/^stm_(\d+)$/)
      if (aMatch && bMatch) {
        return parseInt(aMatch[1]) - parseInt(bMatch[1])
      }
      return a.name.localeCompare(b.name)
    })
  }

  return grouped
}

/**
 * Get display label for a dimension
 * @param dimensionName - The dimension name (e.g., 'utm_source', 'stm_1')
 * @param customDimensionLabels - Optional map of custom dimension labels from workspace settings
 */
export function getDimensionLabel(
  dimensionName: string,
  customDimensionLabels?: Record<string, string> | null,
): string {
  // Custom dimensions: stm_1 -> use custom label if set, otherwise just "1"
  const cdMatch = dimensionName.match(/^stm_(\d+)$/)
  if (cdMatch) {
    const slotNumber = cdMatch[1]
    // Check if there's a custom label for this slot
    if (customDimensionLabels?.[slotNumber]) {
      return customDimensionLabels[slotNumber]
    }
    return slotNumber
  }

  // Libellé FR explicite si connu (app commercialisée en France)
  if (DIMENSION_LABELS_FR[dimensionName]) {
    return DIMENSION_LABELS_FR[dimensionName]
  }

  // Fallback : snake_case -> Title Case
  return dimensionName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Find the maximum median duration in the dataset for heat map scaling
 */
export function findMaxMedianDuration(rows: ExploreRow[]): number {
  let max = 0

  function traverse(items: ExploreRow[]) {
    for (const row of items) {
      if (row.median_duration > max) {
        max = row.median_duration
      }
      if (row.children) {
        traverse(row.children)
      }
    }
  }

  traverse(rows)
  return max
}
