import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { GscOauthTokens } from './entities/gsc-property.entity';

/**
 * Flow OAuth Google pour Search Console — port natif du bridge `gsc/oauth.ts`.
 *
 * Logique pure + `fetch` injectable (les tests unitaires passent un fake, les
 * tests d'intégration tapent le vrai Google quand des creds sont fournis).
 *
 *   1. buildAuthUrl(workspaceId)  → URL Google consent (state HMAC signé).
 *   2. Google redirige sur GOOGLE_OAUTH_REDIRECT_URI?code=...&state=...
 *   3. parseState(state)          → workspaceId vérifié (anti-CSRF).
 *   4. exchangeCode(code)         → tokens (access + refresh + expiry).
 *   5. refreshAccessToken(rt)     → renouvelle l'access_token avant expiration.
 *   6. listSites(accessToken)     → propriétés GSC du compte (résolution auto).
 *
 * State HMAC : `${workspaceId}.${HMAC_SHA256(ENCRYPTION_KEY, workspaceId)}`.
 * Le state ne porte AUCUN secret — juste le workspaceId + sa signature, donc
 * l'attaquant ne peut pas forger un callback pour un autre workspace.
 *
 * Scope demandé : `webmasters.readonly` (suffit pour searchAnalytics.query +
 * sites.list).
 */

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GSC_SITES_URL =
  'https://searchconsole.googleapis.com/webmasters/v3/sites';

export class GscOauthConfigError extends Error {}
export class GscOauthFlowError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

interface OauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Clé maître (ENCRYPTION_KEY) — sert à signer le state HMAC. */
  encryptionKey: string;
}

/** Une propriété GSC telle que renvoyée par sites.list. */
export interface GscSiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

@Injectable()
export class GscOauthService {
  private readonly logger = new Logger(GscOauthService.name);

  constructor(private readonly config: ConfigService) {}

  /** True quand l'OAuth GSC est configuré (client id/secret/redirect présents). */
  isConfigured(): boolean {
    return (
      !!this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID') &&
      !!this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET') &&
      !!this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI')
    );
  }

  private readConfig(): OauthConfig {
    const clientId = this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI');
    const encryptionKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!clientId || !clientSecret || !redirectUri || !encryptionKey) {
      throw new GscOauthConfigError(
        'GSC OAuth not configured: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI / ENCRYPTION_KEY required.',
      );
    }
    return { clientId, clientSecret, redirectUri, encryptionKey };
  }

  // ─── State HMAC (anti-CSRF + carry workspaceId) ────────────────────────

  buildState(workspaceId: string): string {
    const { encryptionKey } = this.readConfig();
    const sig = createHmac('sha256', encryptionKey)
      .update(workspaceId)
      .digest('hex');
    return `${workspaceId}.${sig}`;
  }

  /** Vérifie la signature du state en temps constant et renvoie le workspaceId. */
  parseState(state: string): string {
    const { encryptionKey } = this.readConfig();
    const idx = state.lastIndexOf('.');
    if (idx <= 0) throw new GscOauthFlowError('invalid_state', 400);
    const workspaceId = state.slice(0, idx);
    const sig = state.slice(idx + 1);
    const expected = createHmac('sha256', encryptionKey)
      .update(workspaceId)
      .digest('hex');
    let ok = false;
    try {
      ok = timingSafeEqual(
        Buffer.from(sig, 'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw new GscOauthFlowError('state_signature_mismatch', 400);
    return workspaceId;
  }

  // ─── Flow ──────────────────────────────────────────────────────────────

  buildAuthUrl(workspaceId: string): string {
    const cfg = this.readConfig();
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: GSC_SCOPE,
      access_type: 'offline',
      prompt: 'consent', // force le refresh_token à chaque consent
      state: this.buildState(workspaceId),
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<GscOauthTokens> {
    const cfg = this.readConfig();
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new GscOauthFlowError(
        `token_exchange_failed: ${txt.slice(0, 200)}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
      token_type: 'Bearer';
    };
    if (!data.refresh_token) {
      // Sans refresh_token on ne pourrait pas re-sync demain → on refuse.
      throw new GscOauthFlowError(
        'no_refresh_token_returned (relancer le consent avec prompt=consent)',
        400,
      );
    }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      scope: data.scope,
      token_type: data.token_type,
    };
  }

  async refreshAccessToken(
    refreshToken: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ access_token: string; expires_at: number }> {
    const cfg = this.readConfig();
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new GscOauthFlowError(
        `refresh_failed: ${txt.slice(0, 200)}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    return {
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }

  /**
   * Liste les propriétés GSC accessibles avec cet access_token. Sert à résoudre
   * automatiquement la propriété du workspace après le consent (le bridge
   * legacy ne le faisait jamais → la property restait `__pending__`).
   */
  async listSites(
    accessToken: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<GscSiteEntry[]> {
    const res = await fetchImpl(GSC_SITES_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new GscOauthFlowError(
        `sites_list_failed: ${txt.slice(0, 200)}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
    };
    return (data.siteEntry ?? []).map((s) => ({
      siteUrl: s.siteUrl,
      permissionLevel: s.permissionLevel,
    }));
  }
}
