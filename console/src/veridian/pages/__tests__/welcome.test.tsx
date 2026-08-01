import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { message as antdMessage } from 'antd'

// On mocke `../api` AVANT d'importer le composant : la vérification du tracker
// passe désormais par `fetchCheckTracker` (appel unique, à la demand) et non
// plus par `global.fetch` + polling.
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    fetchCheckTracker: vi.fn(),
  }
})

import {
  VeridianWelcomePage,
  buildTrackerSnippet,
} from '../welcome'
import { fetchCheckTracker, BridgeApiError } from '../../api'

/**
 * Tests Vitest pour l'onboarding `/welcome` (refonte NON BLOQUANTE 2026-06-24).
 *
 * Le mur d'attente d'event a disparu : plus de poll auto qui redirige seulement
 * quand un event arrive. On vérifie ici :
 *   1. snippet généré (unité pure inchangée)
 *   2. rendu + CTA « Accéder à mon tableau de bord » TOUJOURS présent
 *   3. le CTA appelle onComplete immédiatement (non bloquant)
 *   4. navigation entre les 3 étapes
 *   5. bouton copier → navigator.clipboard.writeText
 *   6. vérification à la demande : ok / waiting / 403 (jamais bloquante)
 */

const ENDPOINT = 'https://analytics-engine.app.veridian.site'
const mockFetchCheckTracker = vi.mocked(fetchCheckTracker)

beforeEach(() => {
  // clipboard mock — jsdom n'expose pas navigator.clipboard par défaut.
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  })
  mockFetchCheckTracker.mockReset()
  vi.spyOn(antdMessage, 'success').mockReturnValue(undefined as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── buildTrackerSnippet (unité pure) ──────────────────────────────────────

describe('buildTrackerSnippet', () => {
  it('embeds the workspaceId and endpoint in the snippet', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'acme_boulangerie',
      endpoint: ENDPOINT,
    })
    expect(snippet).toContain('"acme_boulangerie"')
    expect(snippet).toContain(ENDPOINT)
    expect(snippet).toContain('window.StaminadsConfig')
    expect(snippet).toContain('Veridian Analytics')
  })

  it('strips a trailing slash from the endpoint', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'ws1',
      endpoint: 'https://example.com/',
    })
    expect(snippet).not.toContain('example.com//')
    expect(snippet).toContain('https://example.com/sdk/v1/tracker.js')
  })

  it('points the <script src> at the backend contract /sdk/v1/tracker.js', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'ws1',
      endpoint: ENDPOINT,
    })
    expect(snippet).toContain(`${ENDPOINT}/sdk/v1/tracker.js`)
    expect(snippet).not.toContain('staminads.min.js')
    expect(snippet).not.toMatch(/staminads_[\d.]+\.min\.js/)
  })
})

// ─── Rendu + CTA non-bloquant ──────────────────────────────────────────────

describe('VeridianWelcomePage — non-bloquant', () => {
  it('renders the wizard root with step 1 visible', () => {
    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        tenantName="Demo SARL"
      />,
    )
    expect(screen.getByTestId('veridian-welcome-root')).toBeInTheDocument()
    expect(screen.getByTestId('welcome-step-snippet')).toBeInTheDocument()
    expect(screen.getByText(/Bienvenue, Demo SARL/i)).toBeInTheDocument()
  })

  it('always shows a "go to dashboard" CTA that calls onComplete immediately', async () => {
    const onComplete = vi.fn()
    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        onComplete={onComplete}
      />,
    )
    const cta = screen.getByTestId('welcome-enter-dashboard')
    expect(cta).toBeInTheDocument()
    await act(async () => {
      cta.click()
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('the generated snippet contains the workspaceId and endpoint', () => {
    render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )
    const code = screen.getByTestId('welcome-snippet-code')
    expect(code).toHaveTextContent('demo_tenant')
    expect(code).toHaveTextContent('analytics-engine.app.veridian.site')
  })

  it('copy button triggers navigator.clipboard.writeText', async () => {
    render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )
    await act(async () => {
      screen.getByTestId('welcome-copy-button').click()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as string
    expect(copied).toContain('demo_tenant')
  })

  it('cancels the copy reset timer when the page unmounts', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { unmount } = render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )

    await act(async () => {
      screen.getByTestId('welcome-copy-button').click()
    })

    const resetTimerIndex = setTimeoutSpy.mock.calls.findIndex(
      ([, delay]) => delay === 2200,
    )
    expect(resetTimerIndex).toBeGreaterThanOrEqual(0)
    const resetTimer = setTimeoutSpy.mock.results[resetTimerIndex]?.value

    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalledWith(resetTimer)
  })
})

// ─── Navigation entre étapes ───────────────────────────────────────────────

describe('VeridianWelcomePage — navigation', () => {
  it('next button moves from step 1 to step 2 (install)', async () => {
    render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )
    await act(async () => {
      screen.getByTestId('welcome-next-1').click()
    })
    expect(screen.getByTestId('welcome-step-install')).toBeInTheDocument()
  })

  it('back button returns from step 2 to step 1', async () => {
    render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )
    await act(async () => {
      screen.getByTestId('welcome-next-1').click()
    })
    await act(async () => {
      screen.getByTestId('welcome-back-2').click()
    })
    expect(screen.getByTestId('welcome-step-snippet')).toBeInTheDocument()
  })
})

// ─── Étape 3 — vérification à la demande (non bloquante) ────────────────────

describe('VeridianWelcomePage — vérification à la demande', () => {
  async function gotoVerifyStep() {
    await act(async () => {
      screen.getByTestId('welcome-next-1').click()
    })
    await act(async () => {
      screen.getByTestId('welcome-next-2').click()
    })
  }

  it('shows an "ok" panel when the tracker is detected', async () => {
    mockFetchCheckTracker.mockResolvedValue({
      status: 'ok',
      firstSeenAt: '2026-05-22T10:00:00.000Z',
      totalEvents24h: 1,
    })
    render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )
    await gotoVerifyStep()
    await act(async () => {
      screen.getByTestId('welcome-verify-button').click()
    })
    await waitFor(() => {
      expect(screen.getByTestId('welcome-verify-ok')).toBeInTheDocument()
    })
  })

  it('shows a "waiting" panel (non blocking) when no event yet', async () => {
    mockFetchCheckTracker.mockResolvedValue({
      status: 'waiting',
      firstSeenAt: null,
      totalEvents24h: 0,
    })
    render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )
    await gotoVerifyStep()
    await act(async () => {
      screen.getByTestId('welcome-verify-button').click()
    })
    await waitFor(() => {
      expect(screen.getByTestId('welcome-verify-waiting')).toBeInTheDocument()
    })
    // Le CTA dashboard reste disponible même quand aucun event n'est reçu.
    expect(screen.getByTestId('welcome-enter-dashboard-2')).toBeInTheDocument()
  })

  it('shows an access-error panel on a 403 from check-tracker', async () => {
    mockFetchCheckTracker.mockRejectedValue(
      new BridgeApiError('invalid_admin_key', 403, '/check-tracker'),
    )
    render(
      <VeridianWelcomePage workspaceId="demo_tenant" trackerEndpoint={ENDPOINT} />,
    )
    await gotoVerifyStep()
    await act(async () => {
      screen.getByTestId('welcome-verify-button').click()
    })
    await waitFor(() => {
      expect(screen.getByTestId('welcome-verify-error')).toBeInTheDocument()
    })
    expect(screen.getByText(/droits pour vérifier/i)).toBeInTheDocument()
  })
})
