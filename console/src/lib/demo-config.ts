/**
 * Public runtime config for the console.
 *
 * The console bundle is built once and shipped in every backend image
 * (prod, staging, demo). Whether the instance runs in demo mode is therefore
 * only known at runtime — the backend exposes it via `GET /api/public-config`.
 *
 * See api/src/demo/demo.controller.ts#publicConfig.
 */
export interface PublicConfig {
  is_demo: boolean
  demo_workspace_id: string
  contact_email: string
}

const DEFAULT_CONFIG: PublicConfig = {
  is_demo: false,
  demo_workspace_id: 'demo-apple',
  contact_email: 'robert.brunon@veridian.site',
}

/** Pre-built mailto: link for the "request an account" CTA. */
export function demoContactMailto(cfg: PublicConfig): string {
  const subject = encodeURIComponent('Demande Veridian Analytics')
  const body = encodeURIComponent(
    "Bonjour,\n\nJ'ai vu la démo publique de Veridian Analytics et je souhaite " +
      'en savoir plus / ouvrir un compte.\n\nMerci.',
  )
  return `mailto:${cfg.contact_email}?subject=${subject}&body=${body}`
}

/**
 * Fetch the public runtime config. Falls back to a non-demo default if the
 * endpoint is unreachable — a transient network error must never strand the
 * console.
 */
export async function fetchPublicConfig(): Promise<PublicConfig> {
  try {
    const res = await fetch('/api/public-config')
    if (!res.ok) return DEFAULT_CONFIG
    const data = (await res.json()) as Partial<PublicConfig>
    return {
      is_demo: data.is_demo === true,
      demo_workspace_id: data.demo_workspace_id ?? DEFAULT_CONFIG.demo_workspace_id,
      contact_email: data.contact_email ?? DEFAULT_CONFIG.contact_email,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

/**
 * Anonymous auto-login for the public demo. Returns the access token + user,
 * or null if the demo data is not seeded yet (HTTP 503) or the endpoint is
 * disabled (HTTP 403 — not a demo build).
 */
export async function demoLogin(): Promise<{
  access_token: string
  user: { id: string; email: string; name: string; is_super_admin: boolean }
} | null> {
  try {
    const res = await fetch('/api/demo.login', { method: 'POST' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Apply Veridian demo branding to the document head at runtime: title +
 * favicon. Only called when `is_demo` is true, so the internal console keeps
 * its default Staminads branding untouched.
 */
export function applyDemoBranding(): void {
  document.title = 'Veridian Analytics — Démo publique'

  const setIcon = (rel: string, href: string, type?: string) => {
    let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
    if (!link) {
      link = document.createElement('link')
      link.rel = rel
      document.head.appendChild(link)
    }
    if (type) link.type = type
    link.href = href
  }
  // veridian-logo.svg is the Veridian-branded mark shipped for the demo.
  setIcon('icon', '/veridian-logo.svg', 'image/svg+xml')
}
