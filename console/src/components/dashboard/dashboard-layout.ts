import type { ReactNode } from 'react'
import type { DashboardLayout } from '../../types/workspace'

/**
 * Per-client dashboard widget ordering/visibility (ticket N3, 2026-06-23)
 * + widgets custom (VAGUE 2, « comme Twenty »).
 *
 * The native staminads dashboard renders a fixed grid of widgets. Rather than
 * build a custom Veridian dashboard (interdit par la vision), we let a workspace
 * REORDER and HIDE the EXISTING native widgets via `settings.dashboard_layout`
 * (pilotable M2M : `workspaces.setLayout`). VAGUE 2 ajoute en plus des widgets
 * CUSTOM définis par workspace (`dashboard_layout.widgets[]`), injectés dans la
 * même grille — `order` peut référencer une clé native OU un id de widget custom.
 * The metric chart hero stays fixed; only the secondary widget grid is configurable.
 *
 * Default (no layout) → the native order, all widgets shown.
 */

/** Stable keys for the configurable secondary dashboard widgets natifs. */
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

/**
 * Un nœud de la grille = une clé (native OU id de widget custom) + son rendu.
 * `key` est volontairement `string` : les ids custom sont arbitraires (slug
 * workspace), seules les clés natives appartiennent à `DashboardWidgetKey`.
 */
export interface DashboardWidgetNode {
  key: string
  node: ReactNode
}

/**
 * Apply a workspace layout to the widget list (natifs + custom) :
 *   1. drop widgets listed in `hidden_widgets` (ne vise que des clés natives ;
 *      un widget custom se masque en l'omettant de `widgets[]`)
 *   2. emit `order` first (clés connues, dans cet ordre — natives OU ids custom),
 *      then any remaining widgets in their native order (so adding a widget
 *      upstream never makes it silently disappear for clients with a partial
 *      `order`).
 */
export function orderDashboardWidgets(
  widgets: DashboardWidgetNode[],
  layout?: DashboardLayout,
): DashboardWidgetNode[] {
  const hidden = new Set(layout?.hidden_widgets ?? [])
  const visible = widgets.filter((w) => !hidden.has(w.key))
  if (!layout?.order || layout.order.length === 0) return visible

  const byKey = new Map(visible.map((w) => [w.key, w]))
  const ordered: DashboardWidgetNode[] = []
  const used = new Set<string>()
  for (const key of layout.order) {
    const w = byKey.get(key)
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
