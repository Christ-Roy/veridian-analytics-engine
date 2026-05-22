import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import {
  VeridianWelcomePage,
  buildTrackerSnippet,
} from '../welcome';

/**
 * Tests Vitest pour l'onboarding wizard Veridian `/welcome` (U4 / ex-C3).
 *
 * Stratégie de mock :
 *   - `global.fetch` stub pour intercepter check-tracker
 *   - `navigator.clipboard.writeText` mocké pour le bouton copier
 *   - `vi.useFakeTimers()` sur les tests de polling pour piloter les ticks
 *
 * Couvre (cf. ticket C3 "Tests obligatoires") :
 *   1. snippet généré contient workspaceId + bon endpoint
 *   2. bouton copier déclenche navigator.clipboard.writeText + toast
 *   3. navigation entre les 3 étapes
 *   4. polling : waiting → ok → redirection (onComplete)
 *   5. timeout 60s sans event → message d'aide affiché
 *   6. erreur 403 → message d'accès refusé
 */

// ─── Helpers de mock fetch check-tracker ───────────────────────────────────

function mockCheckTracker(
  responses: Array<
    | { status: 'ok' | 'waiting'; firstSeenAt?: string | null; totalEvents24h?: number }
    | { httpStatus: number; error: string }
  >,
) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if ('httpStatus' in r) {
      return {
        ok: false,
        status: r.httpStatus,
        json: async () => ({ error: r.error }),
        text: async () => '',
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: r.status,
        firstSeenAt: r.firstSeenAt ?? null,
        totalEvents24h: r.totalEvents24h ?? (r.status === 'ok' ? 1 : 0),
      }),
      text: async () => '',
    } as Response;
  });
}

const ENDPOINT = 'https://analytics-engine.app.veridian.site';

beforeEach(() => {
  // clipboard mock — jsdom n'expose pas navigator.clipboard par défaut.
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── buildTrackerSnippet (unité pure) ──────────────────────────────────────

describe('buildTrackerSnippet', () => {
  it('embeds the workspaceId and endpoint in the snippet', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'acme_boulangerie',
      endpoint: ENDPOINT,
    });
    expect(snippet).toContain('"acme_boulangerie"');
    expect(snippet).toContain(ENDPOINT);
    expect(snippet).toContain('window.StaminadsConfig');
    expect(snippet).toContain('Veridian Analytics');
  });

  it('strips a trailing slash from the endpoint', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'ws1',
      endpoint: 'https://example.com/',
    });
    expect(snippet).not.toContain('example.com//');
    expect(snippet).toContain('https://example.com/sdk/staminads.min.js');
  });
});

// ─── Rendu + étape 1 ───────────────────────────────────────────────────────

describe('VeridianWelcomePage — étape 1 (snippet)', () => {
  it('renders the wizard root with step 1 visible', () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        tenantName="Demo SARL"
      />,
    );
    expect(screen.getByTestId('veridian-welcome-root')).toBeInTheDocument();
    expect(screen.getByTestId('welcome-step-snippet')).toBeInTheDocument();
    expect(screen.getByText(/Bienvenue, Demo SARL/i)).toBeInTheDocument();
  });

  it('the generated snippet contains the workspaceId and endpoint', () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
      />,
    );
    const code = screen.getByTestId('welcome-snippet-code');
    expect(code).toHaveTextContent('demo_tenant');
    expect(code).toHaveTextContent('analytics-engine.app.veridian.site');
  });

  it('copy button triggers navigator.clipboard.writeText and shows a toast', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
      />,
    );

    await act(async () => {
      screen.getByTestId('welcome-copy-button').click();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as string;
    expect(copied).toContain('demo_tenant');

    await waitFor(() => {
      expect(screen.getByTestId('welcome-copy-toast')).toBeInTheDocument();
    });
  });
});

// ─── Navigation entre étapes ───────────────────────────────────────────────

describe('VeridianWelcomePage — navigation', () => {
  it('next button moves from step 1 to step 2 (install)', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
      />,
    );
    await act(async () => {
      screen.getByTestId('welcome-next-1').click();
    });
    expect(screen.getByTestId('welcome-step-install')).toBeInTheDocument();
  });

  it('back button returns from step 2 to step 1', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
      />,
    );
    await act(async () => {
      screen.getByTestId('welcome-next-1').click();
    });
    await act(async () => {
      screen.getByTestId('welcome-back-2').click();
    });
    expect(screen.getByTestId('welcome-step-snippet')).toBeInTheDocument();
  });
});

// ─── Étape 3 — polling ─────────────────────────────────────────────────────

describe('VeridianWelcomePage — étape 3 (vérification)', () => {
  it('shows the waiting panel when polling starts', async () => {
    globalThis.fetch = mockCheckTracker([
      { status: 'waiting' },
    ]) as unknown as typeof fetch;

    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        pollIntervalMs={50}
        timeoutMs={5000}
      />,
    );

    // step 1 → 2 → 3
    await act(async () => {
      screen.getByTestId('welcome-next-1').click();
    });
    await act(async () => {
      screen.getByTestId('welcome-next-2').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('welcome-verify-waiting')).toBeInTheDocument();
    });
  });

  it('transitions waiting → ok and calls onComplete after redirect delay', async () => {
    // 1er poll waiting, 2e poll ok
    globalThis.fetch = mockCheckTracker([
      { status: 'waiting' },
      { status: 'ok', firstSeenAt: '2026-05-22T10:00:00.000Z' },
    ]) as unknown as typeof fetch;
    const onComplete = vi.fn();

    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        pollIntervalMs={20}
        timeoutMs={10000}
        redirectDelayMs={30}
        onComplete={onComplete}
      />,
    );

    await act(async () => {
      screen.getByTestId('welcome-next-1').click();
    });
    await act(async () => {
      screen.getByTestId('welcome-next-2').click();
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('welcome-verify-ok')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
  });

  it('shows the timeout help panel after the timeout window with no event', async () => {
    globalThis.fetch = mockCheckTracker([
      { status: 'waiting' },
    ]) as unknown as typeof fetch;

    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        pollIntervalMs={50}
        timeoutMs={1200}
      />,
    );

    await act(async () => {
      screen.getByTestId('welcome-next-1').click();
    });
    await act(async () => {
      screen.getByTestId('welcome-next-2').click();
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('welcome-verify-timeout')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Le message d'aide expose les boutons Aide + Refaire le check.
    expect(screen.getByTestId('welcome-help-button')).toBeInTheDocument();
    expect(screen.getByTestId('welcome-retry-button')).toBeInTheDocument();
  });

  it('retry button restarts polling after a timeout', async () => {
    globalThis.fetch = mockCheckTracker([
      { status: 'waiting' },
    ]) as unknown as typeof fetch;

    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        pollIntervalMs={50}
        timeoutMs={1000}
      />,
    );

    await act(async () => {
      screen.getByTestId('welcome-next-1').click();
    });
    await act(async () => {
      screen.getByTestId('welcome-next-2').click();
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('welcome-verify-timeout')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    await act(async () => {
      screen.getByTestId('welcome-retry-button').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('welcome-verify-waiting')).toBeInTheDocument();
    });
  });

  it('shows an access-error panel on a 403 from check-tracker', async () => {
    globalThis.fetch = mockCheckTracker([
      { httpStatus: 403, error: 'invalid_admin_key' },
    ]) as unknown as typeof fetch;

    render(
      <VeridianWelcomePage
        workspaceId="demo_tenant"
        trackerEndpoint={ENDPOINT}
        pollIntervalMs={50}
        timeoutMs={5000}
      />,
    );

    await act(async () => {
      screen.getByTestId('welcome-next-1').click();
    });
    await act(async () => {
      screen.getByTestId('welcome-next-2').click();
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('welcome-verify-error')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(screen.getByText(/droits pour vérifier/i)).toBeInTheDocument();
  });
});
