import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AuthContext, type AuthState } from '../../lib/AuthContext'
import type { PublicConfig } from '../../lib/demo-config'
import { DemoBanner } from '../demo-banner'
import { DemoFooter } from '../demo-footer'

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

const PROD_CFG: PublicConfig = {
  is_demo: false,
  demo_workspace_id: 'demo-apple',
  contact_email: 'robert.brunon@veridian.site',
}

describe('DemoBanner', () => {
  it('renders the Veridian demo banner with a mailto CTA in demo mode', () => {
    render(withAuth(DEMO_CFG, <DemoBanner />))
    const banner = screen.getByTestId('demo-banner')
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveTextContent('Veridian Analytics')

    const cta = screen.getByText(/Demander un compte gratuit/i)
    expect(cta).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:robert.brunon@veridian.site'),
    )
  })

  it('renders nothing when not in demo mode', () => {
    const { container } = render(withAuth(PROD_CFG, <DemoBanner />))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while publicConfig is still loading (null)', () => {
    const { container } = render(withAuth(null, <DemoBanner />))
    expect(container).toBeEmptyDOMElement()
  })
})

describe('DemoFooter', () => {
  it('renders trust signals + veridian.site link in demo mode', () => {
    render(withAuth(DEMO_CFG, <DemoFooter />))
    const footer = screen.getByTestId('demo-footer')
    expect(footer).toHaveTextContent('Hébergé en France')
    expect(footer).toHaveTextContent('200 000 sessions')
    expect(screen.getByText('veridian.site')).toHaveAttribute(
      'href',
      'https://veridian.site',
    )
  })

  it('renders nothing when not in demo mode', () => {
    const { container } = render(withAuth(PROD_CFG, <DemoFooter />))
    expect(container).toBeEmptyDOMElement()
  })
})
