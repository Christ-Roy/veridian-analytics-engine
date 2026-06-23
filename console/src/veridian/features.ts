import type { Workspace, WorkspaceFeatures } from '../types/workspace'

/**
 * Per-client feature gating (ticket N2, 2026-06-23).
 *
 * A workspace declares which optional modules it subscribed to via
 * `settings.features` (pilotable M2M : `workspaces.setFeatures`). The console
 * MASKS the Settings tabs of non-subscribed modules — never greys them out
 * (vision pricing : pas de mur béton / menu grisé). Only the optional feature
 * modules are gated; the native staminads tabs are always visible.
 *
 * BACK-COMPAT (critical): an ABSENT flag means SHOWN. Every existing workspace
 * has no `features` block yet, so it must keep seeing every tab until features
 * are explicitly declared. We only hide a tab when its flag is explicitly false.
 */

/** Feature keys that gate an optional Settings tab. */
export type GatedFeature = keyof WorkspaceFeatures

/**
 * True when a gated feature must be SHOWN for this workspace.
 * Absent flag → shown (back-compat). Explicit `false` → hidden.
 */
export function isFeatureEnabled(
  workspace: Pick<Workspace, 'settings'> | undefined,
  feature: GatedFeature,
): boolean {
  const flags = workspace?.settings?.features
  if (!flags) return true // no features block → everything visible (legacy)
  const value = flags[feature]
  return value !== false
}
