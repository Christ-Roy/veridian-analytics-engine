import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { workspaceQueryOptions } from '../../lib/queries'
import { VeridianDashboardPage } from '../../veridian/pages/dashboard'

/**
 * Route TanStack pour le dashboard Veridian intégré.
 *
 * URL : /veridian/dashboard/:workspaceId
 *
 * On reste sous `_authenticated` pour bénéficier du gate auth global de la
 * console staminads. La page est volontairement scopée (`<div class="veridian-scope">`)
 * pour que son thème dark n'affecte pas le reste de l'app AntDesign.
 *
 * V1 : on récupère le workspace via `workspaceQueryOptions` pour avoir le
 * nom + l'URL du site (header tenant). Si le workspace n'est pas trouvé,
 * TanStack Router lancera son error boundary par défaut.
 */
export const Route = createFileRoute(
  '/_authenticated/veridian/dashboard/$workspaceId',
)({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      workspaceQueryOptions(params.workspaceId),
    )
  },
  component: VeridianDashboardRoute,
})

function VeridianDashboardRoute() {
  const { workspaceId } = Route.useParams()
  const { data: workspace } = useSuspenseQuery(
    workspaceQueryOptions(workspaceId),
  )

  // Extraire le domaine depuis l'URL du site staminads. Si pas dispo, on
  // tombe sur un fallback construit depuis le workspaceId pour que le mailto
  // pré-rempli ait quand même un placeholder cohérent.
  const domainFromUrl = workspace.website
    ? (() => {
        try {
          return new URL(workspace.website).hostname
        } catch {
          return undefined
        }
      })()
    : undefined

  return (
    <VeridianDashboardPage
      workspaceId={workspaceId}
      tenantName={workspace.name}
      tenantSlug={workspace.id}
      tenantDomain={domainFromUrl}
      siteUrl={workspace.website}
    />
  )
}
