import { useAuth } from '../lib/useAuth'
import { demoContactMailto } from '../lib/demo-config'

/**
 * Top banner shown ONLY on the public demo instance (IS_DEMO=true).
 *
 * Purpose: make it unambiguous that the visitor is looking at a Veridian
 * Analytics demo, and convert — a single high-contrast CTA to request a real
 * account. Rendered globally from __root.tsx, above every route.
 *
 * On a non-demo build `publicConfig.is_demo` is false and this renders
 * nothing, so the internal console is never affected.
 */
export function DemoBanner() {
  const { publicConfig } = useAuth()

  if (!publicConfig?.is_demo) return null

  const mailto = demoContactMailto(publicConfig)

  return (
    <div
      data-testid="demo-banner"
      className="w-full flex items-center justify-center gap-3 px-4 py-2 text-sm text-white"
      style={{
        background: 'linear-gradient(90deg, #1d4ed8 0%, #2563eb 50%, #3b82f6 100%)',
      }}
      role="region"
      aria-label="Bandeau démo Veridian Analytics"
    >
      <span className="font-medium">
        Vous regardez la démo publique de <strong>Veridian Analytics</strong>
        <span className="hidden sm:inline">
          {' '}— données générées, lecture seule.
        </span>
      </span>
      <a
        href={mailto}
        className="inline-flex items-center rounded-md bg-white px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm transition-colors hover:bg-blue-50"
        data-demo-cta="header"
      >
        Demander un compte gratuit →
      </a>
    </div>
  )
}
