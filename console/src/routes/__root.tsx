import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { RouterContext } from '../router'
import { DemoBanner } from '../veridian/demo-banner'
import { DemoFooter } from '../veridian/demo-footer'
import { NotFoundPage, AppErrorPage } from '../veridian/error-pages'

function RootLayout() {
  // DemoBanner / DemoFooter render nothing unless IS_DEMO=true (gated on
  // publicConfig from AuthContext), so the internal console is unaffected.
  // Le thème AntD (colorPrimary/colorLink + overrides Card/Table + locale fr)
  // est défini une seule fois dans main.tsx ; pas de ConfigProvider imbriqué
  // ici pour éviter d'écraser ces overrides.
  return (
    <div className="flex min-h-screen flex-col">
      <DemoBanner />
      <div className="flex-1">
        <Outlet />
      </div>
      <DemoFooter />
    </div>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  // 404 brandé Veridian (ticket U9) — remplace le fallback technique nu de
  // TanStack pour toute route inconnue.
  notFoundComponent: NotFoundPage,
  // Écran d'erreur brandé Veridian (ticket U9) — remplace l'ancien Result
  // anglais sur fond gris.
  errorComponent: ({ error }) => <AppErrorPage error={error} />,
})
