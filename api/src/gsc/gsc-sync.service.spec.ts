import { GscSyncService, GscApiError } from './gsc-sync.service';
import { GscOauthService } from './gsc-oauth.service';
import { GscRepository } from './gsc.repository';
import { GscTokenCrypto } from './gsc-token-crypto';
import { GscProperty, GscOauthTokens } from './entities/gsc-property.entity';

const TOKENS: GscOauthTokens = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: Date.now() + 3_600_000,
  scope: 's',
  token_type: 'Bearer',
};

function makeProperty(over: Partial<GscProperty> = {}): GscProperty {
  return {
    id: 'gsc_1',
    workspace_id: 'ws_1',
    site_url: 'sc-domain:exemple.fr',
    ownership_state: 'verified',
    oauth_tokens_encrypted: 'enc',
    last_sync_at: null,
    created_at: '2026-01-01 00:00:00.000',
    updated_at: '2026-01-01 00:00:00.000',
    deleted_at: null,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeService(overrides: {
  repo?: Partial<GscRepository>;
  crypto?: Partial<GscTokenCrypto>;
  oauth?: Partial<GscOauthService>;
} = {}): {
  svc: GscSyncService;
  repo: jest.Mocked<GscRepository>;
} {
  const repo = {
    updateTokens: jest.fn(async () => {}),
    replaceDailyWindow: jest.fn(async (_a, _b, _c, _d, rows: unknown[]) => rows.length),
    markSynced: jest.fn(async () => {}),
    findVerifiedProperties: jest.fn(async () => []),
    ...overrides.repo,
  } as unknown as jest.Mocked<GscRepository>;
  const crypto = {
    decryptTokens: jest.fn(() => TOKENS),
    encryptTokens: jest.fn(() => 'enc2'),
    ...overrides.crypto,
  } as unknown as GscTokenCrypto;
  const oauth = {
    refreshAccessToken: jest.fn(async () => ({
      access_token: 'fresh',
      expires_at: Date.now() + 3_600_000,
    })),
    ...overrides.oauth,
  } as unknown as GscOauthService;
  return { svc: new GscSyncService(repo, oauth, crypto), repo };
}

describe('GscSyncService', () => {
  describe('getAccessToken', () => {
    it('returns the stored token when still valid', async () => {
      const { svc } = makeService();
      const token = await svc.getAccessToken(makeProperty());
      expect(token).toBe('at');
    });

    it('refreshes + persists when near expiry', async () => {
      const { svc, repo } = makeService({
        crypto: {
          decryptTokens: jest.fn(() => ({ ...TOKENS, expires_at: Date.now() })),
          encryptTokens: jest.fn(() => 'enc2'),
        } as unknown as Partial<GscTokenCrypto>,
      });
      const token = await svc.getAccessToken(makeProperty());
      expect(token).toBe('fresh');
      expect(repo.updateTokens).toHaveBeenCalledWith(expect.anything(), 'enc2');
    });

    it('throws when no encrypted token present', async () => {
      const { svc } = makeService();
      await expect(
        svc.getAccessToken(makeProperty({ oauth_tokens_encrypted: '' })),
      ).rejects.toBeInstanceOf(GscApiError);
    });
  });

  describe('querySearchAnalytics backoff', () => {
    it('retries on 429 then succeeds', async () => {
      const { svc } = makeService();
      let calls = 0;
      const fetchImpl = jest.fn(async () => {
        calls++;
        if (calls === 1) return jsonResponse({ error: 'rate' }, 429);
        return jsonResponse({ rows: [{ keys: ['2026-06-01', 'q', 'p', 'fr', 'DESKTOP'], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }] });
      }) as unknown as typeof fetch;
      const rows = await svc.querySearchAnalytics({
        accessToken: 'at',
        propertyUrl: 'sc-domain:exemple.fr',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        dimensions: ['date', 'query', 'page', 'country', 'device'],
        searchType: 'web',
        fetchImpl,
      });
      expect(calls).toBe(2);
      expect(rows).toHaveLength(1);
    });

    it('throws immediately on a non-retryable 403', async () => {
      const { svc } = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({ error: 'forbidden' }, 403),
      ) as unknown as typeof fetch;
      await expect(
        svc.querySearchAnalytics({
          accessToken: 'at',
          propertyUrl: 'p',
          startDate: '2026-06-01',
          endDate: '2026-06-01',
          dimensions: ['date'],
          searchType: 'web',
          fetchImpl,
        }),
      ).rejects.toBeInstanceOf(GscApiError);
    });
  });

  describe('syncProperty', () => {
    it('skips a property that is not verified', async () => {
      const { svc, repo } = makeService();
      const res = await svc.syncProperty(
        makeProperty({ ownership_state: 'pending', site_url: '' }),
      );
      expect(res.errors).toContain('property_not_verified');
      expect(repo.replaceDailyWindow).not.toHaveBeenCalled();
    });

    it('pulls, parses and replaces the window for a verified property', async () => {
      const { svc, repo } = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({
          rows: [
            { keys: ['2026-06-01', 'q1', 'https://exemple.fr/a', 'fra', 'DESKTOP'], clicks: 3, impressions: 30, ctr: 0.1, position: 2.4 },
            // row sans page → filtrée (bruit partiel)
            { keys: ['2026-06-01', 'q2', '', 'fra', 'MOBILE'], clicks: 1, impressions: 5, ctr: 0.2, position: 8 },
          ],
        }),
      ) as unknown as typeof fetch;
      const res = await svc.syncProperty(makeProperty(), {
        days: 7,
        fetchImpl,
        now: () => new Date('2026-06-10T00:00:00Z'),
      });
      expect(res.upserted).toBe(1);
      expect(repo.markSynced).toHaveBeenCalled();
      const insertedRows = repo.replaceDailyWindow.mock.calls[0][4];
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({
        query: 'q1',
        page: 'https://exemple.fr/a',
        clicks: 3,
        impressions: 30,
      });
    });

    it('computes a 2-day-lagged window', async () => {
      const { svc } = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({ rows: [] }),
      ) as unknown as typeof fetch;
      const res = await svc.syncProperty(makeProperty(), {
        days: 7,
        fetchImpl,
        now: () => new Date('2026-06-10T12:00:00Z'),
      });
      // endDate = 2026-06-08 (now-2j), startDate = endDate-6j = 2026-06-02
      expect(res.range.end).toBe('2026-06-08');
      expect(res.range.start).toBe('2026-06-02');
    });
  });

  describe('syncAllVerified', () => {
    it('syncs every verified property and aggregates results', async () => {
      const { svc } = makeService({
        repo: {
          findVerifiedProperties: jest.fn(async () => [
            makeProperty({ id: 'gsc_1' }),
            makeProperty({ id: 'gsc_2' }),
          ]),
          replaceDailyWindow: jest.fn(async () => 0),
          markSynced: jest.fn(async () => {}),
        } as unknown as Partial<GscRepository>,
      });
      const fetchImpl = jest.fn(async () =>
        jsonResponse({ rows: [] }),
      ) as unknown as typeof fetch;
      const results = await svc.syncAllVerified({ fetchImpl });
      expect(results).toHaveLength(2);
    });
  });
});
