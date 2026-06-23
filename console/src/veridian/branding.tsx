import { useEffect } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import type { ReactNode } from 'react'
import type { Workspace } from '../types/workspace'

/**
 * Per-client white-label branding (ticket N1, 2026-06-23).
 *
 * Defiges the console branding that was frozen "Veridian" in hard. A workspace
 * carries `logo_url`, `name` (top-level) and `settings.branding.color` (accent),
 * all pilotable M2M (`workspaces.updateSettings` / `workspaces.setBranding`).
 * When nothing is configured we keep the default Veridian identity.
 *
 * What it drives:
 *   - the `--primary` CSS var (nav, links, active states use it everywhere)
 *   - the antd `colorPrimary` (primary buttons / inputs) via a nested provider
 *   - the document <title> ("<Workspace> · Analytics")
 *   - the favicon (the client's logo when it is a square-ish image)
 *   - the header logo (handled in the layout, reading `brandLogo()`)
 *
 * The demo instance keeps the default Veridian branding (no per-client override)
 * so the public demo is not accidentally white-labelled.
 */

export const DEFAULT_BRAND_COLOR = '#7763f1'
const DEFAULT_LOGO = '/veridian-logo.svg'
const DEFAULT_LOGO_ALT = 'Veridian Analytics'

/** Accent color for a workspace, falling back to the Veridian default. */
export function brandColor(workspace?: Pick<Workspace, 'settings'>): string {
  const c = workspace?.settings?.branding?.color
  return isHexColor(c) ? (c as string) : DEFAULT_BRAND_COLOR
}

/** Header logo src + alt for a workspace (client logo when set). */
export function brandLogo(
  workspace?: Pick<Workspace, 'logo_url' | 'name'>,
  isDemo = false,
): { src: string; alt: string } {
  if (!isDemo && workspace?.logo_url) {
    return { src: workspace.logo_url, alt: workspace.name || DEFAULT_LOGO_ALT }
  }
  return { src: DEFAULT_LOGO, alt: DEFAULT_LOGO_ALT }
}

function isHexColor(c?: string): boolean {
  return typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c)
}

/**
 * Imperatively apply the workspace branding to the document (CSS var, title,
 * favicon). Mounted inside the authenticated workspace layout so it runs with
 * the current workspace in context. Restores the Veridian default on unmount.
 */
export function WorkspaceBrandingEffect({
  workspace,
  isDemo,
}: {
  workspace: Workspace
  isDemo: boolean
}) {
  const color = isDemo ? DEFAULT_BRAND_COLOR : brandColor(workspace)
  const logoUrl = isDemo ? undefined : workspace.logo_url
  const name = workspace.name

  useEffect(() => {
    const root = document.documentElement
    const prevColor = root.style.getPropertyValue('--primary')
    root.style.setProperty('--primary', color)

    const prevTitle = document.title
    document.title = name ? `${name} · Analytics` : 'Veridian Analytics'

    // Favicon: use the client logo when one is configured; otherwise leave the
    // existing (Veridian) favicon untouched.
    let faviconEl: HTMLLinkElement | null = null
    let prevHref: string | null = null
    if (logoUrl) {
      faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!faviconEl) {
        faviconEl = document.createElement('link')
        faviconEl.rel = 'icon'
        document.head.appendChild(faviconEl)
      }
      prevHref = faviconEl.getAttribute('href')
      faviconEl.setAttribute('href', logoUrl)
    }

    return () => {
      if (prevColor) root.style.setProperty('--primary', prevColor)
      else root.style.removeProperty('--primary')
      document.title = prevTitle
      if (faviconEl && prevHref !== null) faviconEl.setAttribute('href', prevHref)
    }
  }, [color, logoUrl, name])

  return null
}

/**
 * Override the antd primary color for the workspace subtree so primary buttons,
 * switches and inputs match the client accent. Wraps the layout content; falls
 * through to the root ConfigProvider for everything else (locale, components).
 */
export function WorkspaceBrandingProvider({
  workspace,
  isDemo,
  children,
}: {
  workspace: Workspace
  isDemo: boolean
  children: ReactNode
}) {
  const color = isDemo ? DEFAULT_BRAND_COLOR : brandColor(workspace)
  // Default color → no nested provider (avoid a needless theme re-computation).
  if (color === DEFAULT_BRAND_COLOR) return <>{children}</>
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: { colorPrimary: color, colorLink: color },
      }}
    >
      {children}
    </ConfigProvider>
  )
}
