import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { VeridianDashboardPage } from '../dashboard';

/**
 * Tests Vitest pour la page dashboard Veridian.
 *
 * Stratégie de mock :
 *   - On stub `global.fetch` pour intercepter les 3 endpoints bridge
 *   - On mock par URL (regex matching le path) pour piloter chaque endpoint
 *     indépendamment (success, error, slow, etc.)
 *
 * Couvre :
 *   1. Loading state initial → skeleton visible
 *   2. Success path → score + grid services + shadow blocks rendus
 *   3. Error state (bridge 500) → carte error + retry button
 *   4. Retry click → relance le fetch et reset à loading
 *   5. 401/403 → message d'erreur friendly auth
 *   6. Empty state → si aucun service actif, render install tracker
 */

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch({
  scoreResponse,
  statusResponse,
  shadowResponse,
  scoreOk = true,
  statusOk = true,
  shadowOk = true,
  scoreStatus = 200,
}: {
  scoreResponse?: unknown;
  statusResponse?: unknown;
  shadowResponse?: unknown;
  scoreOk?: boolean;
  statusOk?: boolean;
  shadowOk?: boolean;
  scoreStatus?: number;
}): FetchMock {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/score')) {
      return {
        ok: scoreOk,
        status: scoreStatus,
        json: async () => scoreResponse ?? { error: 'no_data' },
        text: async () => '',
      } as Response;
    }
    if (url.includes('/status')) {
      return {
        ok: statusOk,
        status: statusOk ? 200 : 500,
        json: async () => statusResponse ?? { error: 'no_data' },
        text: async () => '',
      } as Response;
    }
    if (url.includes('/shadow-marketing')) {
      return {
        ok: shadowOk,
        status: shadowOk ? 200 : 500,
        json: async () => shadowResponse ?? {},
        text: async () => '',
      } as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'not_found' }),
      text: async () => '',
    } as Response;
  });
  return fn;
}

const okScore = {
  workspaceId: 'demo-tenant',
  score: 65,
  label: 'Bon',
  services: {
    active: ['pageviews'],
    inactive: ['forms', 'calls', 'gsc', 'ads', 'pagespeed'],
  },
};

const okStatus = {
  workspaceId: 'demo-tenant',
  activeServices: ['pageviews'],
  inactiveServices: ['forms', 'calls', 'gsc', 'ads', 'pagespeed'],
  counts: {
    pageviews: 1234,
    forms: 0,
    calls: 0,
    gscRows: 0,
    gscClicks: 0,
    gscImpressions: 0,
    gscProperty: null,
  },
};

const okShadow = {};

beforeEach(() => {
  // jsdom: AbortSignal exists, just ensure clean fetch
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VeridianDashboardPage', () => {
  it('renders skeleton while loading', () => {
    // fetch never resolves
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;

    render(
      <VeridianDashboardPage
        workspaceId="demo-tenant"
        tenantName="Demo Tenant"
        tenantDomain="demo.veridian.site"
      />,
    );

    expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('veridian-dashboard-root')).toBeInTheDocument();
  });

  it('renders score hero + active service block + shadow blocks on success', async () => {
    globalThis.fetch = mockFetch({
      scoreResponse: okScore,
      statusResponse: okStatus,
      shadowResponse: okShadow,
    }) as unknown as typeof fetch;

    render(
      <VeridianDashboardPage
        workspaceId="demo-tenant"
        tenantName="Demo Tenant"
        tenantDomain="demo.veridian.site"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('score-value')).toHaveTextContent('65');
    });

    expect(screen.getByTestId('score-active-count')).toHaveTextContent('1');
    expect(screen.getByTestId('active-services-grid')).toBeInTheDocument();
    expect(screen.getByTestId('shadow-marketing-grid')).toBeInTheDocument();
    expect(screen.getByTestId('service-pageviews')).toBeInTheDocument();
    // Some shadow blocks
    expect(screen.getByTestId('shadow-forms')).toBeInTheDocument();
    expect(screen.getByTestId('shadow-gsc')).toBeInTheDocument();
  });

  it('renders error state with retry button when bridge returns 500', async () => {
    globalThis.fetch = mockFetch({
      scoreOk: false,
      scoreStatus: 500,
    }) as unknown as typeof fetch;

    render(
      <VeridianDashboardPage
        workspaceId="demo-tenant"
        tenantName="Demo Tenant"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
  });

  it('shows friendly auth message on 403', async () => {
    globalThis.fetch = mockFetch({
      scoreOk: false,
      scoreStatus: 403,
    }) as unknown as typeof fetch;

    render(<VeridianDashboardPage workspaceId="demo-tenant" />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-error')).toBeInTheDocument();
    });

    expect(screen.getByText(/droits pour consulter/i)).toBeInTheDocument();
  });

  it('retry click resets to loading then renders data', async () => {
    let firstCall = true;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (firstCall && url.includes('/score')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'down' }),
          text: async () => '',
        } as Response;
      }
      if (url.includes('/score')) {
        return {
          ok: true,
          status: 200,
          json: async () => okScore,
          text: async () => '',
        } as Response;
      }
      if (url.includes('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => okStatus,
          text: async () => '',
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => okShadow,
        text: async () => '',
      } as Response;
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    render(<VeridianDashboardPage workspaceId="demo-tenant" />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-error')).toBeInTheDocument();
    });

    firstCall = false;
    await act(async () => {
      screen.getByTestId('retry-button').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('score-value')).toHaveTextContent('65');
    });
  });

  it('renders empty state when no active services', async () => {
    const emptyStatus = {
      ...okStatus,
      activeServices: [] as string[],
      inactiveServices: [
        'pageviews',
        'forms',
        'calls',
        'gsc',
        'ads',
        'pagespeed',
        'push',
      ],
      counts: { ...okStatus.counts, pageviews: 0 },
    };
    const emptyScore = {
      ...okScore,
      score: 0,
      label: 'À démarrer',
      services: {
        active: [],
        inactive: emptyStatus.inactiveServices,
      },
    };
    globalThis.fetch = mockFetch({
      scoreResponse: emptyScore,
      statusResponse: emptyStatus,
      shadowResponse: okShadow,
    }) as unknown as typeof fetch;

    render(
      <VeridianDashboardPage
        workspaceId="demo-tenant"
        tenantName="Demo"
        tenantDomain="demo.veridian.site"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('empty-install-tracker')).toBeInTheDocument();
    });
  });

  it('renders header with tenant name and domain', async () => {
    globalThis.fetch = mockFetch({
      scoreResponse: okScore,
      statusResponse: okStatus,
      shadowResponse: okShadow,
    }) as unknown as typeof fetch;

    render(
      <VeridianDashboardPage
        workspaceId="demo-tenant"
        tenantName="Acme Boulangerie"
        tenantDomain="acme-boulangerie.fr"
        siteUrl="https://acme-boulangerie.fr"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Acme Boulangerie')).toBeInTheDocument();
    });

    expect(screen.getByText(/acme-boulangerie\.fr/i)).toBeInTheDocument();
    expect(screen.getByTestId('visit-site-button')).toHaveAttribute(
      'href',
      'https://acme-boulangerie.fr',
    );
  });

  it('fetches all 3 endpoints in parallel', async () => {
    const fetchFn = mockFetch({
      scoreResponse: okScore,
      statusResponse: okStatus,
      shadowResponse: okShadow,
    });
    globalThis.fetch = fetchFn as unknown as typeof fetch;

    render(<VeridianDashboardPage workspaceId="demo-tenant" />);

    await waitFor(() => {
      expect(screen.getByTestId('score-value')).toBeInTheDocument();
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const calls = fetchFn.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(calls.some((u: string) => u.includes('/score'))).toBe(true);
    expect(calls.some((u: string) => u.includes('/status'))).toBe(true);
    expect(calls.some((u: string) => u.includes('/shadow-marketing'))).toBe(
      true,
    );
  });
});
