import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { ConfigProvider, Result, Button } from 'antd'
import type { RouterContext } from '../router'
import { DemoBanner } from '../veridian/demo-banner'
import { DemoFooter } from '../veridian/demo-footer'

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
  errorComponent: ({ error }) => (
    <ConfigProvider>
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Result
          status="error"
          title="Something went wrong"
          subTitle={error?.message || 'An unexpected error occurred'}
          extra={
            <Button type="primary" onClick={() => window.location.href = '/'}>
              Go Home
            </Button>
          }
        />
      </div>
    </ConfigProvider>
  ),
})
