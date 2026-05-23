import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AuthContext, type AuthState } from '../../../lib/AuthContext'
import type { PublicConfig } from '../../../lib/demo-config'
import { VeridianDashboardPage } from '../dashboard'
import { VeridianDemoComingSoon } from '../demo-coming-soon'

function makeAuth(publicConfig: PublicConfig | null): AuthState {
  return {
    token: null,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: async () => {},
    logout: () => {},
    publicConfig,
    isDemo: publicConfig?.is_demo ?? false,
  }
}

function withAuth(publicConfig: PublicConfig | null, node: ReactNode) {
  return (
    <AuthContext.Provider value={makeAuth(publicConfig)}>
      {node}
    </AuthContext.Provider>
  )
}

const DEMO_CFG: PublicConfig = {
  is_demo: true,
  demo_workspace_id: 'demo-apple',
  contact_email: 'robert.brunon@veridian.site',
}

describe('VeridianDemoComingSoon', () => {
  it('renders the demo placeholder with name, domain, and mailto CTA', () => {
    render(
      withAuth(
        DEMO_CFG,
        <VeridianDemoComingSoon
          tenantName="Demo Apple"
          tenantDomain="apple.com"
        />,
      ),
    )
    const root = screen.getByTestId('veridian-demo-coming-soon')
    expect(root).toHaveTextContent('Demo Apple')
    expect(root).toHaveTextContent('apple.com')
    expect(root).toHaveTextContent(/Bientôt disponible/i)
    const cta = screen.getByText(/Demander un compte gratuit/i)
    expect(cta).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:robert.brunon@veridian.site'),
    )
  })
})

describe('VeridianDashboardPage demo gate (BUG-02)', () => {
  it('renders the coming-soon placeholder (not a 404) when isDemo=true', () => {
    // fetch must NEVER be called in demo — the gate short-circuits before
    // any bridge API call. If we see a fetch, the gate is broken.
    const fetchSpy = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchSpy

    render(
      withAuth(
        DEMO_CFG,
        <VeridianDashboardPage
          workspaceId="demo-apple"
          tenantName="Demo Apple"
          tenantDomain="apple.com"
        />,
      ),
    )

    expect(screen.getByTestId('veridian-demo-coming-soon')).toBeInTheDocument()
    expect(screen.queryByTestId('veridian-dashboard-root')).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
