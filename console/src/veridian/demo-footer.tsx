import { useAuth } from '../lib/useAuth'
import { demoContactMailto } from '../lib/demo-config'

/**
 * Footer shown ONLY on the public demo instance (IS_DEMO=true).
 *
 * Reinforces trust signals (hosted in France, no third-party cookies, demo
 * data origin) and offers a secondary conversion path. Rendered globally
 * from __root.tsx. Renders nothing on a non-demo build.
 */
export function DemoFooter() {
  const { publicConfig } = useAuth()

  if (!publicConfig?.is_demo) return null

  const mailto = demoContactMailto(publicConfig)

  return (
    <footer
      data-testid="demo-footer"
      className="w-full border-t border-white/10 bg-slate-900 px-4 py-3 text-center text-[11px] text-slate-300"
      aria-label="Pied de page démo Veridian Analytics"
    >
      <span>
        Hébergé en France · Pas de cookies tiers · Démo générée à partir de
        200 000 visites uniques
      </span>
      <span className="mx-2 text-slate-600">·</span>
      <a
        href="https://veridian.site"
        className="text-blue-300 underline hover:text-blue-200"
        target="_blank"
        rel="noopener noreferrer"
      >
        veridian.site
      </a>
      <span className="mx-2 text-slate-600">·</span>
      <a
        href={mailto}
        className="text-blue-300 underline hover:text-blue-200"
        data-demo-cta="footer"
      >
        Demander une démo réelle
      </a>
    </footer>
  )
}
