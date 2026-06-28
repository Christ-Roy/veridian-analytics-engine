import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AuthContext, type AuthState } from '../../lib/AuthContext'
import type { PublicConfig } from '../../lib/demo-config'

// Le composant lit `__APP_VERSION__` (define Vite, absent de vitest.config.ts)
// → on le pose en global avant l'import du composant. Major 12 = APP_VERSION.
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__APP_VERSION__ = '12.0.0'
})

// On mocke `useQuery` pour ne pas embarquer QueryClient ni le client API réel :
// le test cible la logique de gate `isDemo`, pas le fetch analytics.
const mockUseQuery = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}))

// `analyticsQueryOptions` tire `./api` (axios + import.meta.env) — stub inutile
// pour ce test, on le neutralise.
vi.mock('../../lib/queries', () => ({
  analyticsQueryOptions: () => ({ queryKey: ['analytics'], queryFn: vi.fn() }),
}))

// `<Link>` de TanStack Router exige un RouterProvider — on le réduit à une
// ancre simple pour tester le rendu du bandeau sans monter un routeur.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}))

// Import APRÈS les mocks (hoisting vi.mock garanti, mais explicite ici).
import { SdkVersionWarning } from '../../components/dashboard/SdkVersionWarning'

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

// Une session avec un sdk_version non-semver (data mockée historique) →
// déclenche normalement le bandeau « SDK obsolète » hors démo.
function mismatchedData() {
  return {
    data: { data: [{ sdk_version: 'vrddemo-seed-1.0', sessions: 42 }] },
    isLoading: false,
  }
}

function matchedData() {
  return {
    data: { data: [{ sdk_version: '12.4.1', sessions: 42 }] },
    isLoading: false,
  }
}

describe('SdkVersionWarning — gate démo (lot B5)', () => {
  it('ne rend RIEN en mode démo, même avec un sdk_version non-semver', () => {
    mockUseQuery.mockReturnValue(mismatchedData())
    const { container } = render(
      withAuth(
        DEMO_CFG,
        <SdkVersionWarning workspaceId="demo-apple" timezone="Europe/Paris" />,
      ),
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText(/SDK obsolète/i)).not.toBeInTheDocument()
  })

  it('AFFICHE le bandeau hors démo quand le major diverge (régression : le gate ne casse pas le comportement normal)', () => {
    mockUseQuery.mockReturnValue(mismatchedData())
    render(
      withAuth(
        PROD_CFG,
        <SdkVersionWarning workspaceId="ws-prod" timezone="Europe/Paris" />,
      ),
    )
    expect(screen.getByText(/SDK obsolète/i)).toBeInTheDocument()
  })

  it('ne rend rien hors démo quand le major correspond', () => {
    mockUseQuery.mockReturnValue(matchedData())
    const { container } = render(
      withAuth(
        PROD_CFG,
        <SdkVersionWarning workspaceId="ws-prod" timezone="Europe/Paris" />,
      ),
    )
    expect(container).toBeEmptyDOMElement()
  })
})
