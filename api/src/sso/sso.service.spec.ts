import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SsoService } from './sso.service';
import { hashToken } from '../common/crypto';

/**
 * Tests du cœur de sécurité du SSO.
 *
 * On teste ici ce qui, s'il cassait, donnerait une prise de contrôle de compte
 * client : le rejeu, l'expiration, le cloisonnement entre workspaces, et le
 * refus d'énumérer les comptes existants.
 */

interface FakeRow {
  id: string;
  token_hash: string;
  user_id: string;
  workspace_id: string;
  status: 'pending' | 'used';
  issued_to_hub_user_id: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_ip: string;
  created_at: string;
  updated_at: string;
}

function chDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function makeHarness(
  opts: {
    users?: Record<
      string,
      {
        id: string;
        email: string;
        name: string;
        status: string;
        is_super_admin: boolean;
      }
    >;
    memberships?: Array<{ user_id: string; workspace_id: string }>;
    tokenRows?: FakeRow[];
  } = {},
) {
  const users = opts.users ?? {};
  const memberships = opts.memberships ?? [];
  const tokenRows = opts.tokenRows ?? [];
  const inserted: Array<{ table: string; rows: Record<string, unknown>[] }> =
    [];

  const clickhouse = {
    insertSystem: jest.fn(
      async (table: string, rows: Record<string, unknown>[]) => {
        inserted.push({ table, rows });
        if (table === 'sso_login_tokens') {
          for (const row of rows) {
            const idx = tokenRows.findIndex(
              (r) => r.token_hash === row.token_hash,
            );
            if (idx >= 0) tokenRows[idx] = row as unknown as FakeRow;
            else tokenRows.push(row as unknown as FakeRow);
          }
        }
      },
    ),
    querySystem: jest.fn(
      async (sql: string, params: Record<string, string>) => {
        if (sql.includes('FROM sso_login_tokens')) {
          return tokenRows.filter((r) => r.token_hash === params.tokenHash);
        }
        if (sql.includes('FROM workspace_memberships')) {
          const mine = memberships.filter((m) => m.user_id === params.userId);
          if (params.workspaceId !== undefined) {
            return [
              {
                count: mine.filter((m) => m.workspace_id === params.workspaceId)
                  .length,
              },
            ];
          }
          return mine
            .slice()
            .sort((a, b) => a.workspace_id.localeCompare(b.workspace_id))
            .map((m) => ({ workspace_id: m.workspace_id }));
        }
        return [];
      },
    ),
  };

  const usersService = {
    findByEmail: jest.fn(async (email: string) => {
      return (
        Object.values(users).find((u) => u.email === email.toLowerCase()) ??
        null
      );
    }),
    findById: jest.fn(async (id: string) => users[id] ?? null),
  };

  const authService = {
    issueSessionForUser: jest.fn(async () => ({
      access_token: 'jwt-de-test',
      session_id: 'sess-1',
    })),
  };

  const auditService = { log: jest.fn(async () => undefined) };

  const configService = {
    get: (key: string) =>
      key === 'APP_URL' ? 'https://analytics.example.test' : undefined,
  } as unknown as ConfigService;

  const service = new SsoService(
    clickhouse as never,
    usersService as never,
    authService as never,
    auditService as never,
    configService,
  );

  return {
    service,
    clickhouse,
    usersService,
    authService,
    auditService,
    tokenRows,
    inserted,
  };
}

const ACTIVE_USER = {
  id: 'user-1',
  email: 'client@example.com',
  name: 'Client Test',
  status: 'active',
  is_super_admin: false,
};

describe('SsoService — émission', () => {
  it("émet un jeton et place celui-ci dans le FRAGMENT de l'URL, jamais en query string", async () => {
    const { service, inserted } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      memberships: [{ user_id: 'user-1', workspace_id: 'ws-alpha' }],
    });

    const result = await service.issueToken({ email: 'client@example.com' });

    // Le fragment est ce qui empêche le jeton d'atterrir dans les logs
    // d'accès et dans l'en-tête Referer. Une régression vers `?t=` doit être
    // détectée ici.
    expect(result.autologin_url).toMatch(
      /^https:\/\/analytics\.example\.test\/sso#[0-9a-f]{64}$/,
    );
    expect(result.autologin_url).not.toContain('?');
    expect(result.expires_in).toBe(120);

    // Seul le HASH est stocké : une fuite de la base ne permet de rejouer
    // aucun jeton.
    const row = inserted[0].rows[0] as unknown as FakeRow;
    const rawToken = result.autologin_url.split('#')[1];
    expect(row.token_hash).toBe(hashToken(rawToken));
    expect(JSON.stringify(row)).not.toContain(rawToken);
  });

  it('lie le jeton au workspace demandé quand le user en est membre', async () => {
    const { service, inserted } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      memberships: [
        { user_id: 'user-1', workspace_id: 'ws-alpha' },
        { user_id: 'user-1', workspace_id: 'ws-beta' },
      ],
    });

    await service.issueToken({
      email: 'client@example.com',
      workspaceId: 'ws-beta',
    });

    expect((inserted[0].rows[0] as unknown as FakeRow).workspace_id).toBe(
      'ws-beta',
    );
  });

  it("refuse un workspace dont le user n'est pas membre (cloisonnement entre tenants)", async () => {
    // Le scénario redouté : un jeton qui ouvrirait l'espace d'un autre client.
    const { service } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      memberships: [{ user_id: 'user-1', workspace_id: 'ws-alpha' }],
    });

    await expect(
      service.issueToken({
        email: 'client@example.com',
        workspaceId: 'ws-du-voisin',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuse un compte suspendu — le SSO ne doit pas contourner une désactivation', async () => {
    const { service } = makeHarness({
      users: {
        'user-1': { ...ACTIVE_USER, status: 'suspended' },
      },
      memberships: [{ user_id: 'user-1', workspace_id: 'ws-alpha' }],
    });

    await expect(
      service.issueToken({ email: 'client@example.com' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuse un user sans aucun workspace', async () => {
    const { service } = makeHarness({ users: { 'user-1': ACTIVE_USER } });

    await expect(
      service.issueToken({ email: 'client@example.com' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("ne permet pas de distinguer un email inconnu d'un compte non éligible", async () => {
    // Anti-énumération : les deux refus doivent être indiscernables, sinon la
    // route devient un outil de cartographie de la base clients.
    const { service } = makeHarness({
      users: { 'user-1': { ...ACTIVE_USER, status: 'suspended' } },
      memberships: [{ user_id: 'user-1', workspace_id: 'ws-alpha' }],
    });

    const inconnu = await service
      .issueToken({ email: 'personne@example.com' })
      .catch((e: Error) => e);
    const suspendu = await service
      .issueToken({ email: 'client@example.com' })
      .catch((e: Error) => e);

    expect((inconnu as Error).message).toBe((suspendu as Error).message);
  });

  it('refuse une demande sans identifiant', async () => {
    const { service } = makeHarness();
    await expect(service.issueToken({})).rejects.toThrow(UnauthorizedException);
  });
});

describe('SsoService — consommation', () => {
  function pendingRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
      id: 'tok-1',
      token_hash: hashToken('jeton-brut-de-test'),
      user_id: 'user-1',
      workspace_id: 'ws-alpha',
      status: 'pending',
      issued_to_hub_user_id: '',
      expires_at: chDate(new Date(Date.now() + 60_000)),
      consumed_at: null,
      consumed_ip: '',
      created_at: chDate(new Date()),
      updated_at: chDate(new Date()),
      ...overrides,
    };
  }

  it('ouvre une session et renvoie le workspace lié au jeton', async () => {
    const { service, authService } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      tokenRows: [pendingRow()],
    });

    const result = await service.consume('jeton-brut-de-test', '203.0.113.7');

    expect(result.access_token).toBe('jwt-de-test');
    expect(result.workspace_id).toBe('ws-alpha');
    expect(result.user.email).toBe('client@example.com');
    // La session SSO doit passer par le même chemin qu'un login classique,
    // sinon elle échapperait aux révocations.
    expect(authService.issueSessionForUser).toHaveBeenCalledTimes(1);
  });

  it("refuse le rejeu d'un jeton déjà consommé", async () => {
    const { service, authService } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      tokenRows: [pendingRow()],
    });

    await service.consume('jeton-brut-de-test');
    await expect(service.consume('jeton-brut-de-test')).rejects.toThrow(
      UnauthorizedException,
    );
    // Aucune seconde session ne doit avoir été ouverte.
    expect(authService.issueSessionForUser).toHaveBeenCalledTimes(1);
  });

  it('refuse un jeton expiré', async () => {
    const { service } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      tokenRows: [
        pendingRow({ expires_at: chDate(new Date(Date.now() - 1000)) }),
      ],
    });

    await expect(service.consume('jeton-brut-de-test')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un jeton inconnu', async () => {
    const { service } = makeHarness({ users: { 'user-1': ACTIVE_USER } });
    await expect(service.consume('jeton-inexistant')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un jeton vide sans interroger la base', async () => {
    const { service, clickhouse } = makeHarness();
    await expect(service.consume('')).rejects.toThrow(UnauthorizedException);
    expect(clickhouse.querySystem).not.toHaveBeenCalled();
  });

  it("re-vérifie le statut du compte à la consommation, pas seulement à l'émission", async () => {
    // Un compte suspendu APRÈS l'émission ne doit pas pouvoir être rouvert par
    // un jeton encore valide.
    const { service } = makeHarness({
      users: { 'user-1': { ...ACTIVE_USER, status: 'suspended' } },
      tokenRows: [pendingRow()],
    });

    await expect(service.consume('jeton-brut-de-test')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("brûle le jeton avant d'ouvrir la session", async () => {
    // Si l'ouverture de session échoue, le jeton ne doit pas rester
    // réutilisable.
    const { service, authService, tokenRows } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      tokenRows: [pendingRow()],
    });
    authService.issueSessionForUser.mockRejectedValueOnce(
      new Error('panne de session'),
    );

    await expect(service.consume('jeton-brut-de-test')).rejects.toThrow(
      'panne de session',
    );
    expect(tokenRows[0].status).toBe('used');

    await expect(service.consume('jeton-brut-de-test')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('renvoie le même message pour un jeton inconnu, expiré ou consommé', async () => {
    const { service } = makeHarness({
      users: { 'user-1': ACTIVE_USER },
      tokenRows: [
        pendingRow({
          token_hash: hashToken('expire'),
          expires_at: chDate(new Date(Date.now() - 1000)),
        }),
        pendingRow({ token_hash: hashToken('consomme'), status: 'used' }),
      ],
    });

    const messages = await Promise.all(
      ['inconnu', 'expire', 'consomme'].map((t) =>
        service.consume(t).catch((e: Error) => e.message),
      ),
    );

    expect(new Set(messages).size).toBe(1);
  });
});
