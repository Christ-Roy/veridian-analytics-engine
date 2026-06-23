import type { ReactNode } from 'react'
import type { DashboardLayout } from '../../types/workspace'

/**
 * Per-client dashboard widget ordering/visibility (ticket N3, 2026-06-23).
 *
 * The native staminads dashboard renders a fixed grid of widgets. Rather than
 * build a custom Veridian dashboard (interdit par la vision), we let a workspace
 * REORDER and HIDE the EXISTING native widgets via `settings.dashboard_layout`
 * (pilotable M2M : `workspaces.setLayout`). The metric chart hero stays fixed;
 * only the secondary widget grid is configurable.
 *
 * Default (no layout) → the native order, all widgets shown.
 */

/** Stable keys for the configurable secondary dashboard widgets. */
export const DASHBOARD_WIDGET_KEYS = [
  'pages',
  'sources',
  'campaigns',
  'countries',
  'heatmap',
  'devices',
  'page_views',
  'goals',
] as const

export type DashboardWidgetKey = (typeof DASHBOARD_WIDGET_KEYS)[number]

export interface DashboardWidget {
  key: DashboardWidgetKey
  node: ReactNode
}

/**
 * Apply a workspace layout to the native widget list:
 *   1. drop widgets listed in `hidden_widgets`
 *   2. emit `order` first (known keys, in that order), then any remaining
 *      widgets in their native order (so adding a widget upstream never makes it
 *      silently disappear for clients with a partial `order`).
 */
export function orderDashboardWidgets(
  widgets: DashboardWidget[],
  layout?: DashboardLayout,
): DashboardWidget[] {
  const hidden = new Set(layout?.hidden_widgets ?? [])
  const visible = widgets.filter((w) => !hidden.has(w.key))
  if (!layout?.order || layout.order.length === 0) return visible

  const byKey = new Map(visible.map((w) => [w.key, w]))
  const ordered: DashboardWidget[] = []
  const used = new Set<string>()
  for (const key of layout.order) {
    const w = byKey.get(key as DashboardWidgetKey)
    if (w && !used.has(key)) {
      ordered.push(w)
      used.add(key)
    }
  }
  // Append any visible widget not named in `order`, native order preserved.
  for (const w of visible) {
    if (!used.has(w.key)) ordered.push(w)
  }
  return ordered
}
