import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query'
import { workspaceQueryOptions } from '../../../../lib/queries'
import { api } from '../../../../lib/api'
import { VeridianWelcomePage } from '../../../../veridian/pages/welcome'

/**
 * Sous-route native `/workspaces/:workspaceId/welcome` — port native de
 * l'ex-route parallèle `/veridian/welcome/:workspaceId` (ticket UI-WELCOME-NATIVE,
 * sprint 2026-05-22).
 *
 * Pourquoi sous-route native plutôt que tunnel ? L'ancien chemin
 * `/veridian/welcome/...` bypassait le layout staminads (`workspaces/$workspaceId.tsx`)
 * → pas de nav, pas de breadcrumbs, pas de bouton Assistant. En intégrant la
 * welcome comme sous-route, on hérite automatiquement de ces éléments tout en
 * gardant le wizard scopé sous `.veridian-scope` (pas de pollution AntDesign).
 *
 * Comportements :
 *   - Si le workspace a déjà reçu un event tracker (status === 'active'),
 *     on redirige automatiquement vers le dashboard Veridian → l'utilisateur
 *     ne se retrouve pas bloqué dans l'onboarding s'il revient par erreur.
 *   - À la fin du wizard (event détecté), on flag `status = 'active'` puis
 *     on redirige vers le dashboard staminads natif `/workspaces/:id`.
 */
export const Route = createFileRoute(
  '/_authenticated/workspaces/$workspaceId/welcome',
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
  const queryClient = useQueryClient()
  const { data: workspace } = useSuspenseQuery(
    workspaceQueryOptions(workspaceId),
  )

  // Workspace déjà actif → on n'a rien à faire ici, redirect vers dashboard.
  // Cas typique : l'utilisateur clique sur le lien "Démarrage" alors qu'il
  // a déjà installé le tracker, ou il revient via un bookmark.
  useEffect(() => {
    if (workspace.status === 'active') {
      void navigate({
        to: '/workspaces/$workspaceId',
        params: { workspaceId },
        replace: true,
      })
    }
  }, [workspace.status, navigate, workspaceId])

  return (
    <VeridianWelcomePage
      workspaceId={workspaceId}
      trackerEndpoint={resolveTrackerEndpoint()}
      tenantName={workspace.name}
      onComplete={async () => {
        // Tracker détecté côté bridge → on marque le workspace actif
        // (sortie du gate du layout) puis on bascule sur le dashboard.
        // On ignore une éventuelle erreur d'update : le bridge peut déjà
        // l'avoir fait via webhook tracker, et le user a quand même le
        // droit d'aller voir son dashboard.
        try {
          await api.workspaces.update({ id: workspaceId, status: 'active' })
          await queryClient.refetchQueries({
            queryKey: ['workspaces', workspaceId],
          })
          await queryClient.refetchQueries({ queryKey: ['workspaces'] })
        } catch {
          /* déjà actif ou problème non-bloquant — on continue */
        }
        void navigate({
          to: '/workspaces/$workspaceId',
          params: { workspaceId },
        })
      }}
    />
  )
}
