import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { workspaceQueryOptions } from '../../../../lib/queries'
import { VeridianDashboardPage } from '../../../../veridian/pages/dashboard'

/**
 * Sous-route TanStack pour le dashboard Veridian, intégrée NATIVEMENT
 * dans le layout staminads (workspaces/$workspaceId/...).
 *
 * URL : /workspaces/:workspaceId/veridian
 *
 * Remplace l'ancien tunnel parallèle `/veridian/dashboard/:workspaceId`
 * qui contournait le layout staminads (nav, sélecteur workspace, breadcrumb).
 * En vivant comme sous-route de `$workspaceId`, on hérite automatiquement :
 *  - de l'auth guard `_authenticated`
 *  - du header staminads (logo, workspace selector, nav)
 *  - de l'AssistantProvider + AssistantPanel
 *  - de la redirection install-sdk si workspace non-actif
 *
 * Le contenu interne (`VeridianDashboardPage`) reste scopé sous
 * `.veridian-scope` pour que son thème dark n'affecte pas l'AntDesign hôte.
 */
export const Route = createFileRoute(
  '/_authenticated/workspaces/$workspaceId/veridian',
)({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      workspaceQueryOptions(params.workspaceId),
    )
  },
  component: WorkspaceVeridianRoute,
})

function WorkspaceVeridianRoute() {
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
