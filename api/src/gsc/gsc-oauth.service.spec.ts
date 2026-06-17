import { ConfigService } from '@nestjs/config';
import {
  GscOauthService,
  GscOauthConfigError,
  GscOauthFlowError,
} from './gsc-oauth.service';

const CFG = {
  GOOGLE_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://analytics-engine.app.veridian.site/api/gsc/oauth-callback',
  ENCRYPTION_KEY: 'k'.repeat(64),
};

function makeService(map: Record<string, string> = CFG): GscOauthService {
  const config = { get: (k: string) => map[k] } as unknown as ConfigService;
  return new GscOauthService(config);
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('GscOauthService', () => {
  describe('config gating', () => {
    it('isConfigured() reflects presence of client id/secret/redirect', () => {
      expect(makeService().isConfigured()).toBe(true);
      expect(makeService({ ENCRYPTION_KEY: 'k'.repeat(64) }).isConfigured()).toBe(
        false,
      );
    });

    it('buildAuthUrl throws GscOauthConfigError when unconfigured', () => {
      expect(() => makeService({}).buildAuthUrl('ws_1')).toThrow(
        GscOauthConfigError,
      );
    });
  });

  describe('state HMAC (anti-CSRF)', () => {
    it('round-trips the workspaceId through build/parse', () => {
      const svc = makeService();
      const state = svc.buildState('ws_abc');
      expect(svc.parseState(state)).toBe('ws_abc');
    });

    it('rejects a tampered workspace id', () => {
      const svc = makeService();
      const state = svc.buildState('ws_abc');
      const [, sig] = state.split('.');
      expect(() => svc.parseState(`ws_evil.${sig}`)).toThrow(GscOauthFlowError);
    });

    it('rejects a malformed state', () => {
      const svc = makeService();
      expect(() => svc.parseState('no-dot')).toThrow(GscOauthFlowError);
    });

    it('embeds the signed state in the consent URL', () => {
      const svc = makeService();
      const url = new URL(svc.buildAuthUrl('ws_abc'));
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(svc.parseState(url.searchParams.get('state') ?? '')).toBe('ws_abc');
    });
  });

  describe('exchangeCode', () => {
    it('returns tokens with computed expiry', async () => {
      const svc = makeService();
      const now = Date.now();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          scope: 'webmasters.readonly',
          token_type: 'Bearer',
        }),
      ) as unknown as typeof fetch;
      const tokens = await svc.exchangeCode('code123', fetchImpl);
      expect(tokens.access_token).toBe('at');
      expect(tokens.refresh_token).toBe('rt');
      expect(tokens.expires_at).toBeGreaterThanOrEqual(now + 3600 * 1000 - 50);
    });

    it('throws when Google omits the refresh_token', async () => {
      const svc = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({
          access_token: 'at',
          expires_in: 3600,
          scope: 's',
          token_type: 'Bearer',
        }),
      ) as unknown as typeof fetch;
      await expect(svc.exchangeCode('c', fetchImpl)).rejects.toBeInstanceOf(
        GscOauthFlowError,
      );
    });

    it('propagates a non-2xx token endpoint error', async () => {
      const svc = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({ error: 'invalid_grant' }, 400),
      ) as unknown as typeof fetch;
      await expect(svc.exchangeCode('c', fetchImpl)).rejects.toBeInstanceOf(
        GscOauthFlowError,
      );
    });
  });

  describe('refreshAccessToken', () => {
    it('returns a refreshed access token + expiry', async () => {
      const svc = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({ access_token: 'at2', expires_in: 1800 }),
      ) as unknown as typeof fetch;
      const r = await svc.refreshAccessToken('rt', fetchImpl);
      expect(r.access_token).toBe('at2');
      expect(r.expires_at).toBeGreaterThan(Date.now());
    });
  });

  describe('listSites', () => {
    it('maps the siteEntry array', async () => {
      const svc = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({
          siteEntry: [
            { siteUrl: 'sc-domain:exemple.fr', permissionLevel: 'siteOwner' },
            { siteUrl: 'https://exemple.fr/', permissionLevel: 'siteFullUser' },
          ],
        }),
      ) as unknown as typeof fetch;
      const sites = await svc.listSites('at', fetchImpl);
      expect(sites).toHaveLength(2);
      expect(sites[0].siteUrl).toBe('sc-domain:exemple.fr');
    });

    it('returns [] when no sites', async () => {
      const svc = makeService();
      const fetchImpl = jest.fn(async () =>
        jsonResponse({}),
      ) as unknown as typeof fetch;
      expect(await svc.listSites('at', fetchImpl)).toEqual([]);
    });
  });
});
