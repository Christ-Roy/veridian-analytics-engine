import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { ConfigProvider } from 'antd'
import type { RouterContext } from '../router'
import { DemoBanner } from '../veridian/demo-banner'
import { DemoFooter } from '../veridian/demo-footer'
import { NotFoundPage, AppErrorPage } from '../veridian/error-pages'

function RootLayout() {
  // DemoBanner / DemoFooter render nothing unless IS_DEMO=true (gated on
  // publicConfig from AuthContext), so the internal console is unaffected.
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#7763f1',
        },
      }}
    >
      <div className="flex min-h-screen flex-col">
        <DemoBanner />
        <div className="flex-1">
          <Outlet />
        </div>
        <DemoFooter />
      </div>
    </ConfigProvider>
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
