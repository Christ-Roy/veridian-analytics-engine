import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { CallsTab } from '../dashboard-tabs/calls-tab';
import { formatDuration, formatCallDate } from '../dashboard-tabs/calls-hooks';

/**
 * Tests Vitest pour le tab Calls (ticket U9).
 *
 * Le tab consomme `GET /api/admin/tenant/:wsId/calls?days=30` via le hook
 * `useCalls`. On stub `global.fetch` et on pilote les états :
 *
 *   - loading           → skeleton
 *   - ready (N appels)  → stats + graphe + table
 *   - ready (0 appel)   → empty state
 *   - 404 (B-VOIP pas livré) / voipConnected=false → not-connected
 *   - 500 / 403         → erreur + retry
 *
 * Le 404 traité comme « non branché » est le point critique : tant que le
 * ticket B-VOIP n'a pas livré son endpoint, le bridge répond 404 et le tab
 * doit afficher un onboarding propre, jamais une erreur rouge.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const okCalls = {
  workspaceId: 'demo-tenant',
  days: 30,
  voipConnected: true,
  calls: [
    {
      id: 'c1',
      startedAt: '2026-05-20T14:32:00.000Z',
      direction: 'inbound',
      peerNumber: '+33612345678',
      durationSec: 184,
      status: 'answered',
      recordingUrl: 'https://rec.veridian.site/c1.mp3',
    },
    {
      id: 'c2',
      startedAt: '2026-05-21T09:10:00.000Z',
      direction: 'inbound',
      peerNumber: '+33700112233',
      durationSec: 0,
      status: 'missed',
      recordingUrl: null,
    },
    {
      id: 'c3',
      startedAt: '2026-05-21T16:45:00.000Z',
      direction: 'outbound',
      peerNumber: '+33655443322',
      durationSec: 92,
      status: 'answered',
      recordingUrl: null,
    },
  ],
  stats: {
    total: 3,
    missed: 1,
    avgDurationSec: 138,
    answerRate: 0.6667,
  },
  daily: [
    { day: '2026-05-20', total: 1, missed: 0 },
    { day: '2026-05-21', total: 2, missed: 1 },
  ],
};

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CallsTab', () => {
  it('shows skeleton while loading', () => {
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    expect(screen.getByTestId('calls-skeleton')).toBeInTheDocument();
  });

  it('renders stats, chart and table on success', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse(okCalls),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-stats')).toBeInTheDocument();
    });

    expect(screen.getByTestId('calls-daily-chart')).toBeInTheDocument();
    expect(screen.getByTestId('calls-table')).toBeInTheDocument();
    // 3 lignes d'appels
    expect(screen.getAllByTestId('call-row')).toHaveLength(3);
    // Lien d'enregistrement présent pour l'appel c1
    expect(screen.getByTestId('call-recording-link')).toHaveAttribute(
      'href',
      'https://rec.veridian.site/c1.mp3',
    );
  });

  it('shows missed-call count in stats', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse(okCalls),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-stats')).toBeInTheDocument();
    });

    expect(screen.getByText('Appels manqués')).toBeInTheDocument();
    expect(screen.getByText('Taux de réponse')).toBeInTheDocument();
  });

  it('shows not-connected state when bridge returns 404 (B-VOIP not shipped)', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse({ error: 'not_found' }, 404),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-not-connected')).toBeInTheDocument();
    });

    // 404 ne doit JAMAIS produire la carte d'erreur rouge.
    expect(screen.queryByTestId('calls-error')).not.toBeInTheDocument();
  });

  it('shows not-connected state when voipConnected is false', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        jsonResponse({
          ...okCalls,
          voipConnected: false,
          calls: [],
        }),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-not-connected')).toBeInTheDocument();
    });
  });

  it('fires onOpenSettings from the not-connected CTA when provided', async () => {
    const onOpenSettings = vi.fn();
    globalThis.fetch = vi.fn(
      async () => jsonResponse({ error: 'not_found' }, 404),
    ) as unknown as typeof fetch;

    render(
      <CallsTab
        workspaceId="demo-tenant"
        siteDomain="demo.fr"
        onOpenSettings={onOpenSettings}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('calls-cta-settings')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByTestId('calls-cta-settings').click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('falls back to a mailto CTA when no onOpenSettings is provided', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse({ error: 'not_found' }, 404),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-cta-mailto')).toBeInTheDocument();
    });

    expect(screen.getByTestId('calls-cta-mailto').getAttribute('href')).toMatch(
      /^mailto:contact@veridian\.site/,
    );
  });

  it('shows empty state when VoIP connected but 0 calls', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        jsonResponse({
          ...okCalls,
          calls: [],
          daily: [],
          stats: { total: 0, missed: 0, avgDurationSec: 0, answerRate: 0 },
        }),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-empty')).toBeInTheDocument();
    });
  });

  it('shows error state with retry on bridge 500', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse({ error: 'boom' }, 500),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('calls-retry-button')).toBeInTheDocument();
  });

  it('shows friendly auth message on 403', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse({ error: 'forbidden' }, 403),
    ) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-error')).toBeInTheDocument();
    });

    expect(screen.getByText(/droits pour consulter/i)).toBeInTheDocument();
  });

  it('retry button reloads and renders data after a transient 500', async () => {
    let firstCall = true;
    globalThis.fetch = vi.fn(async () => {
      if (firstCall) {
        firstCall = false;
        return jsonResponse({ error: 'down' }, 500);
      }
      return jsonResponse(okCalls);
    }) as unknown as typeof fetch;

    render(<CallsTab workspaceId="demo-tenant" siteDomain="demo.fr" />);

    await waitFor(() => {
      expect(screen.getByTestId('calls-error')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByTestId('calls-retry-button').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('calls-table')).toBeInTheDocument();
    });
  });
});

describe('calls-hooks formatters', () => {
  it('formatDuration handles m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(184)).toBe('3:04');
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('formatCallDate produces a fr-FR short label', () => {
    const out = formatCallDate('2026-05-20T14:32:00.000Z');
    // Le label exact dépend du fuseau jsdom — on valide le format général.
    expect(out).toMatch(/·/);
    expect(out.length).toBeGreaterThan(5);
  });

  it('formatCallDate echoes the input on invalid date', () => {
    expect(formatCallDate('not-a-date')).toBe('not-a-date');
  });
});
