import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { workspaceQueryOptions } from '../../../../lib/queries'
import { CallsTab } from '../../../../veridian/pages/dashboard-tabs/calls-tab'
import '../../../../veridian/theme.css'

/**
 * Sous-route TanStack pour la page « Appels » (téléphonie OVH/Telnyx).
 *
 * URL : /workspaces/:workspaceId/calls
 *
 * Page native dans le layout staminads (header, workspace selector, nav,
 * AssistantPanel hérités du layout parent `$workspaceId.tsx`). Le contenu
 * vit sous `.veridian-scope` pour utiliser le thème dark Veridian sans
 * polluer le thème AntDesign hôte.
 *
 * Consomme `GET /api/admin/tenant/:wsId/calls?days=30` via le composant
 * `CallsTab` (réutilisé depuis l'ancien dashboard à tabs custom — c'était
 * déjà une vraie page bien faite, on la rend juste accessible en sous-route).
 */
export const Route = createFileRoute(
  '/_authenticated/workspaces/$workspaceId/calls',
)({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      workspaceQueryOptions(params.workspaceId),
    )
  },
  component: WorkspaceCallsRoute,
})

function WorkspaceCallsRoute() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const { data: workspace } = useSuspenseQuery(
    workspaceQueryOptions(workspaceId),
  )

  const domain = workspace.website
    ? (() => {
        try {
          return new URL(workspace.website).hostname
        } catch {
          return undefined
        }
      })()
    : undefined

  const siteDomain = domain ?? `${workspaceId}.veridian.site`

  return (
    <div className="veridian-scope min-h-[60vh] px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="veridian-fade-in space-y-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Veridian Analytics
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Appels
          </h1>
          <p className="text-sm text-muted-foreground">
            Suivi des appels téléphoniques entrants et sortants sur {siteDomain}
            {' '}— 30 derniers jours.
          </p>
        </header>

        <CallsTab
          workspaceId={workspaceId}
          siteDomain={siteDomain}
          onOpenSettings={() =>
            navigate({
              to: '/workspaces/$workspaceId/settings',
              params: { workspaceId },
              search: { section: 'integrations' },
            })
          }
        />
      </div>
    </div>
  )
}
