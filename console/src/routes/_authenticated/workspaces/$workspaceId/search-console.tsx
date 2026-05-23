import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { workspaceQueryOptions } from '../../../../lib/queries'
import { GscPerformanceDashboard } from '../../../../veridian/gsc/performance-dashboard'
import '../../../../veridian/theme.css'

/**
 * Sous-route TanStack pour la page « Search Console » (GSC).
 *
 * URL : /workspaces/:workspaceId/search-console
 *
 * Page native dans le layout staminads (header, workspace selector, nav,
 * AssistantPanel hérités du layout parent `$workspaceId.tsx`). Le contenu
 * vit sous `.veridian-scope` pour utiliser le thème dark Veridian sans
 * polluer le thème AntDesign hôte.
 *
 * Consomme `GET /api/admin/tenant/:wsId/gsc?days=N` via le composant
 * `GscPerformanceDashboard` (porté depuis le legacy
 * `veridian-analytics/components/gsc/`).
 */
export const Route = createFileRoute(
  '/_authenticated/workspaces/$workspaceId/search-console',
)({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      workspaceQueryOptions(params.workspaceId),
    )
  },
  component: WorkspaceSearchConsoleRoute,
})

function WorkspaceSearchConsoleRoute() {
  const { workspaceId } = Route.useParams()
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
            Search Console
          </h1>
          <p className="text-sm text-muted-foreground">
            Vos performances sur Google : clics, impressions, position moyenne,
            mots-clés et pages — synchronisées chaque nuit depuis Search Console.
          </p>
        </header>

        <GscPerformanceDashboard
          workspaceId={workspaceId}
          siteDomain={siteDomain}
        />
      </div>
    </div>
  )
}
