import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { VeridianSettingsPage } from '../settings';

/**
 * Tests Vitest — page Settings Veridian (U8).
 *
 * Stratégie : on stub `global.fetch` et on route par méthode + path.
 *
 * Couvre :
 *   - loading → skeleton
 *   - success → les 5 sections rendues
 *   - error (bridge 500) → carte erreur + retry
 *   - siteKey copiable
 *   - GSC connecté / déconnecté
 *   - VoIP : credential existant masqué, formulaire d'ajout
 *   - toggle notification → appelle PUT /settings
 *   - les credentials ne sont jamais affichés en clair
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

const baseSettings = {
  tenant: {
    id: 't1',
    workspaceId: 'ws1',
    slug: 'acme',
    name: 'Acme Corp',
    plan: 'pro',
    status: 'active',
  },
  sites: [
    {
      id: 'site1',
      domain: 'acme.fr',
      name: 'Site Acme',
      siteKey: 'sk_abcdef123456',
      createdAt: '2026-05-01T00:00:00.000Z',
    },
  ],
  gsc: {
    connected: false,
    propertyUrl: null,
    ownershipState: null,
    lastSyncAt: null,
  },
  credentials: [] as unknown[],
  notifications: {
    notifyNewLead: true,
    notifyWeeklyReport: true,
    notifyEmail: null,
    pushAdminEnabled: true,
  },
  tracking: {
    visitorIdEnabled: true,
    cookieConsentEnabled: false,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

/**
 * Mock fetch : route par (method, path). `getBody` permet d'évoluer la
 * réponse entre les appels (ex: après un PUT).
 */
function mockFetch(opts: {
  settings?: unknown;
  settingsStatus?: number;
  onPut?: (body: unknown) => unknown;
  onPost?: (body: unknown) => unknown;
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsedBody = init?.body ? JSON.parse(init.body as string) : undefined;

    if (url.includes('/settings') && method === 'GET') {
      return jsonResponse(
        opts.settings ?? baseSettings,
        opts.settingsStatus ?? 200,
      );
    }
    if (url.includes('/settings') && method === 'PUT') {
      const updated = opts.onPut
        ? opts.onPut(parsedBody)
        : { ...baseSettings, ...(parsedBody as object) };
      return jsonResponse(updated);
    }
    if (url.includes('/credentials') && method === 'POST') {
      const result = opts.onPost
        ? opts.onPost(parsedBody)
        : { ok: true, credential: {} };
      return jsonResponse(result, 201);
    }
    return jsonResponse({ error: 'not_found' }, 404);
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch({}));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VeridianSettingsPage', () => {
  it('affiche un skeleton pendant le chargement', () => {
    render(<VeridianSettingsPage workspaceId="ws1" />);
    expect(screen.getByTestId('settings-skeleton')).toBeInTheDocument();
  });

  it('rend les 5 sections après chargement', async () => {
    render(<VeridianSettingsPage workspaceId="ws1" accountEmail="x@acme.fr" />);
    await waitFor(() =>
      expect(
        screen.getByTestId('settings-section-account'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('settings-section-site')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-gsc')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-voip')).toBeInTheDocument();
    expect(
      screen.getByTestId('settings-section-notifications'),
    ).toBeInTheDocument();
  });

  it('affiche le nom du tenant et la formule', async () => {
    render(<VeridianSettingsPage workspaceId="ws1" accountEmail="x@acme.fr" />);
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    expect(screen.getByText('x@acme.fr')).toBeInTheDocument();
    expect(screen.getByText('pro')).toBeInTheDocument();
  });

  it('affiche la siteKey et un bouton copier', async () => {
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByText('sk_abcdef123456')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('copy-sitekey')).toBeInTheDocument();
  });

  it('affiche un état erreur + retry quand le bridge répond 500', async () => {
    vi.stubGlobal('fetch', mockFetch({ settingsStatus: 500 }));
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('settings-error')).toBeInTheDocument(),
    );
  });

  it('GSC : affiche le bouton "Connecter" quand non connecté', async () => {
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('gsc-disconnected')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('gsc-connect-btn')).toBeInTheDocument();
  });

  it('GSC : affiche le statut connecté avec la propriété', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        settings: {
          ...baseSettings,
          gsc: {
            connected: true,
            propertyUrl: 'sc-domain:acme.fr',
            ownershipState: 'verified',
            lastSyncAt: '2026-05-20T10:00:00.000Z',
          },
        },
      }),
    );
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('gsc-connected')).toBeInTheDocument(),
    );
    expect(screen.getByText('sc-domain:acme.fr')).toBeInTheDocument();
  });

  it('VoIP : affiche le formulaire de saisie de credentials', async () => {
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('voip-form')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('voip-provider-select')).toBeInTheDocument();
    expect(screen.getByTestId('voip-save-btn')).toBeInTheDocument();
  });

  it('VoIP : affiche les credentials existants masqués (jamais en clair)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        settings: {
          ...baseSettings,
          credentials: [
            {
              kind: 'voip_telnyx',
              label: 'Telnyx',
              status: 'ok',
              masked: { apiKey: '••••6789' },
              lastSyncAt: null,
              lastTestedAt: '2026-05-21T00:00:00.000Z',
              lastError: null,
              createdAt: '2026-05-20T00:00:00.000Z',
              updatedAt: '2026-05-21T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('voip-cred-voip_telnyx')).toBeInTheDocument(),
    );
    // Valeur masquée affichée, jamais le secret complet.
    expect(screen.getByText('••••6789')).toBeInTheDocument();
    expect(screen.queryByText(/KEY[0-9A-Za-z]{10,}/)).not.toBeInTheDocument();
    // Boutons tester / supprimer présents.
    expect(screen.getByTestId('voip-test-voip_telnyx')).toBeInTheDocument();
    expect(screen.getByTestId('voip-delete-voip_telnyx')).toBeInTheDocument();
  });

  it('VoIP : bouton "Enregistrer" désactivé tant que les champs sont vides', async () => {
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('voip-save-btn')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('voip-save-btn')).toBeDisabled();
  });

  it('Notifications : un toggle déclenche un PUT /settings', async () => {
    const putSpy = vi.fn((body: unknown) => ({
      ...baseSettings,
      notifications: { ...baseSettings.notifications, ...(body as object) },
    }));
    vi.stubGlobal('fetch', mockFetch({ onPut: putSpy }));
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('toggle-notify-new-lead')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-notify-new-lead'));
    });
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy).toHaveBeenCalledWith({ notifyNewLead: false });
  });

  it('Notifications : les toggles tracking sont présents', async () => {
    render(<VeridianSettingsPage workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('toggle-visitor-id')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('toggle-cookie-consent')).toBeInTheDocument();
  });

  it('affiche un lien de gestion du compte quand accountSettingsUrl fourni', async () => {
    render(
      <VeridianSettingsPage
        workspaceId="ws1"
        accountSettingsUrl="/workspaces/ws1/account"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText('Changer email / mot de passe'),
      ).toBeInTheDocument(),
    );
  });
});
