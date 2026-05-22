import type { AnalyticsResponse } from '../types/analytics'
import type { DimensionData } from '../types/dashboard'

/** Default metrics for backward compatibility */
const DEFAULT_METRICS = ['sessions', 'median_duration']

/**
 * Coerce a raw metric value into a number.
 *
 * ClickHouse sérialise les agrégats numériques en STRING dans le JSON de
 * réponse (`count()` → "200000", etc.). Les anciens `(row[metric] as number)`
 * étaient des assertions TS mensongères : aucune conversion runtime. Une
 * valeur string atteignait alors `formatValue` → `formatNumber` → `.toFixed`
 * et plantait le dashboard (`t.toFixed is not a function`).
 *
 * - null / undefined → undefined (préserve l'absence de donnée comparée)
 * - valeur non numérique → 0 (fail-safe, pas de NaN propagé à l'UI)
 */
function toMetricNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

/**
 * Transforms an analytics API response to the standard DimensionData format.
 * Handles both comparison and non-comparison responses.
 *
 * @param response - The raw analytics API response
 * @param dimensionField - The field name containing the dimension value (e.g., 'device', 'landing_path')
 * @param metrics - Array of metric field names to extract (defaults to ['sessions', 'median_duration'])
 * @returns Array of DimensionData objects
 */
export function transformToDimensionData(
  response: AnalyticsResponse | undefined,
  dimensionField: string,
  metrics: string[] = DEFAULT_METRICS
): DimensionData[] {
  if (!response?.data) return []

  // Check if response has comparison data structure
  const hasComparison =
    typeof response.data === 'object' &&
    'current' in response.data &&
    Array.isArray(response.data.current)

  if (hasComparison) {
    const { current, previous } = response.data as {
      current: Record<string, unknown>[]
      previous: Record<string, unknown>[]
    }

    return current.map((row) => {
      const dimensionValue = row[dimensionField] as string
      const prevRow = previous?.find((p) => p[dimensionField] === dimensionValue)

      const result: DimensionData = {
        dimension_value: dimensionValue ?? '',
      }

      // Dynamically extract each metric and its previous value.
      // Number coercion obligatoire : ClickHouse renvoie les agrégats en
      // string (cf. toMetricNumber).
      for (const metric of metrics) {
        result[metric] = toMetricNumber(row[metric]) ?? 0
        if (prevRow) {
          result[`prev_${metric}`] = toMetricNumber(prevRow[metric])
        }
      }

      return result
    })
  }

  // No comparison - flat array
  const rows = response.data as Record<string, unknown>[]
  return rows.map((row) => {
    const result: DimensionData = {
      dimension_value: (row[dimensionField] as string) ?? '',
    }

    for (const metric of metrics) {
      result[metric] = toMetricNumber(row[metric]) ?? 0
    }

    return result
  })
}
