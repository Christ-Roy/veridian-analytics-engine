import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { workspaceQueryOptions } from '../../lib/queries'
import { VeridianSettingsPage } from '../../veridian/pages/settings'

/**
 * Route TanStack pour la page Settings Veridian (U8).
 *
 * URL : /veridian/settings/:workspaceId
 *
 * Sous `_authenticated` — bénéficie du gate auth global de la console
 * staminads. La page est scopée (`.veridian-scope`) : son thème dark
 * n'affecte pas le reste de l'app AntDesign.
 *
 * Le workspace est chargé via `workspaceQueryOptions` pour récupérer l'email
 * du compte (affiché en lecture dans la section Compte). Si le workspace
 * n'est pas trouvé, l'error boundary TanStack prend le relais.
 */
export const Route = createFileRoute(
  '/_authenticated/veridian/settings/$workspaceId',
)({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      workspaceQueryOptions(params.workspaceId),
    )
  },
  component: VeridianSettingsRoute,
})

function VeridianSettingsRoute() {
  const { workspaceId } = Route.useParams()
  const { data: workspace } = useSuspenseQuery(
    workspaceQueryOptions(workspaceId),
  )

  return (
    <VeridianSettingsPage
      workspaceId={workspaceId}
      accountEmail={
        (workspace as { ownerEmail?: string; email?: string }).ownerEmail ??
        (workspace as { email?: string }).email
      }
      accountSettingsUrl={`/workspaces/${workspaceId}/account`}
    />
  )
}
