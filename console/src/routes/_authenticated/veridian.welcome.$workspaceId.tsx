import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { workspaceQueryOptions } from '../../lib/queries'
import { VeridianWelcomePage } from '../../veridian/pages/welcome'

/**
 * Route TanStack pour l'onboarding wizard Veridian (ticket U4 / ex-C3).
 *
 * URL : /veridian/welcome/:workspaceId
 *
 * Accessible :
 *   - juste après le provisioning d'un nouveau tenant (atterrissage)
 *   - via le CTA "Installer le tracker" du dashboard quand 0 event reçu
 *
 * On reste sous `_authenticated` pour bénéficier du gate auth global de la
 * console staminads. La page est scopée (`.veridian-scope`) — son thème dark
 * teal n'affecte pas le reste de l'app AntDesign.
 *
 * Endpoint du tracker injecté dans le snippet :
 *   - prod  : VITE_VERIDIAN_TRACKER_URL (= analytics-engine.app.veridian.site)
 *   - dev   : fallback sur window.location.origin (la console et l'engine
 *             partagent l'origine en local).
 */
export const Route = createFileRoute(
  '/_authenticated/veridian/welcome/$workspaceId',
)({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      workspaceQueryOptions(params.workspaceId),
    )
  },
  component: VeridianWelcomeRoute,
})

/**
 * Résout l'URL publique du tracker à coller dans le snippet. En build prod,
 * Vite remplace `import.meta.env.VITE_VERIDIAN_TRACKER_URL` ; sinon on tombe
 * sur l'origine courante (cas dev local où engine + console cohabitent).
 */
function resolveTrackerEndpoint(): string {
  const env = import.meta.env as Record<string, string | undefined>
  return (
    env?.VITE_VERIDIAN_TRACKER_URL ??
    (typeof window !== 'undefined'
      ? window.location.origin
      : 'https://analytics-engine.app.veridian.site')
  )
}

function VeridianWelcomeRoute() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const { data: workspace } = useSuspenseQuery(
    workspaceQueryOptions(workspaceId),
  )

  return (
    <VeridianWelcomePage
      workspaceId={workspaceId}
      trackerEndpoint={resolveTrackerEndpoint()}
      tenantName={workspace.name}
      onComplete={() => {
        // Tracker détecté → on bascule sur le dashboard Veridian du tenant.
        void navigate({
          to: '/veridian/dashboard/$workspaceId',
          params: { workspaceId },
        })
      }}
    />
  )
}
