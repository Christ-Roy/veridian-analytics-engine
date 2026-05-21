/**
 * Google OAuth flow pour Search Console.
 *
 * Flow :
 *   1. oauthBeginFlow(tenantId) → URL Google consent à ouvrir
 *   2. Google redirige sur /api/admin/gsc/oauth-callback?code=...&state=...
 *   3. oauthCallback(code, state) → échange code contre tokens, chiffre, persiste
 *
 * Tokens stockés chiffrés AES-256-GCM (clé TOKEN_ENCRYPTION_KEY 32 hex bytes).
 * Le clear-text contient { access_token, refresh_token, expires_at, scope }.
 *
 * Scope demandé : webmasters.readonly (suffisant pour searchAnalytics.query
 * et sites.list).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface OauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** 32-byte hex key (64 hex chars) */
  encryptionKey: string;
}

export interface OauthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms epoch
  scope: string;
  token_type: "Bearer";
}

export interface EncryptedBlob {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class OauthConfigError extends Error {}
export class OauthFlowError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

export function readOauthConfigFromEnv(): OauthConfig {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

  if (!clientId || !clientSecret || !redirectUri || !encryptionKey) {
    throw new OauthConfigError(
      "OAuth config missing: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI / TOKEN_ENCRYPTION_KEY",
    );
  }
  if (encryptionKey.length !== 64 || !/^[0-9a-f]+$/i.test(encryptionKey)) {
    throw new OauthConfigError(
      "TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate via: openssl rand -hex 32",
    );
  }
  return { clientId, clientSecret, redirectUri, encryptionKey };
}

// ─── Chiffrement AES-256-GCM ──────────────────────────────────────────────

export function encryptTokens(tokens: OauthTokens, hexKey: string): EncryptedBlob {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new OauthConfigError("encryption key must be 32 bytes (64 hex chars)");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: enc.toString("hex"),
  };
}

export function decryptTokens(blob: EncryptedBlob, hexKey: string): OauthTokens {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new OauthConfigError("encryption key must be 32 bytes (64 hex chars)");
  }
  const iv = Buffer.from(blob.iv, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ct = Buffer.from(blob.ciphertext, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as OauthTokens;
}

// ─── State HMAC (anti-CSRF + carry tenantId) ──────────────────────────────

export function buildState(tenantId: string, hexKey: string): string {
  const sig = createHmac("sha256", Buffer.from(hexKey, "hex"))
    .update(tenantId)
    .digest("hex");
  return `${tenantId}.${sig}`;
}

export function parseState(state: string, hexKey: string): string {
  const idx = state.lastIndexOf(".");
  if (idx <= 0) throw new OauthFlowError("invalid_state");
  const tenantId = state.slice(0, idx);
  const sig = state.slice(idx + 1);
  const expected = createHmac("sha256", Buffer.from(hexKey, "hex"))
    .update(tenantId)
    .digest("hex");
  if (sig !== expected) throw new OauthFlowError("state_signature_mismatch");
  return tenantId;
}

// ─── Flow ─────────────────────────────────────────────────────────────────

export function oauthBeginFlow(tenantId: string, cfg: OauthConfig): { url: string; state: string } {
  const state = buildState(tenantId, cfg.encryptionKey);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state };
}

export async function exchangeCode(
  code: string,
  cfg: OauthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<OauthTokens> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new OauthFlowError(`token_exchange_failed: ${txt.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: "Bearer";
  };
  if (!data.refresh_token) {
    throw new OauthFlowError(
      "no_refresh_token_returned (re-consent avec prompt=consent)",
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

export async function refreshAccessToken(
  refreshToken: string,
  cfg: OauthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ access_token: string; expires_at: number }> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new OauthFlowError(`refresh_failed: ${txt.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function persistTokensForTenant(
  prisma: PrismaClient,
  tenantId: string,
  tokens: OauthTokens,
  encryptionKey: string,
): Promise<void> {
  const blob = encryptTokens(tokens, encryptionKey);
  await prisma.gscProperty.upsert({
    where: {
      tenantId_siteUrl: { tenantId, siteUrl: "__pending__" },
    },
    update: {
      oauthAccount: blob as unknown as object,
      ownershipState: "pending",
    },
    create: {
      tenantId,
      siteUrl: "__pending__",
      type: "SITE",
      ownershipState: "pending",
      oauthAccount: blob as unknown as object,
    },
  });
}

export async function getAccessTokenForProperty(
  prisma: PrismaClient,
  gscPropertyId: string,
  cfg: OauthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const prop = await prisma.gscProperty.findUnique({ where: { id: gscPropertyId } });
  if (!prop || !prop.oauthAccount) {
    throw new OauthFlowError("property_or_oauth_missing", 404);
  }
  const blob = prop.oauthAccount as unknown as EncryptedBlob;
  const tokens = decryptTokens(blob, cfg.encryptionKey);
  if (tokens.expires_at > Date.now() + 30_000) {
    return tokens.access_token;
  }
  const fresh = await refreshAccessToken(tokens.refresh_token, cfg, fetchImpl);
  const updated: OauthTokens = {
    ...tokens,
    access_token: fresh.access_token,
    expires_at: fresh.expires_at,
  };
  const newBlob = encryptTokens(updated, cfg.encryptionKey);
  await prisma.gscProperty.update({
    where: { id: gscPropertyId },
    data: { oauthAccount: newBlob as unknown as object },
  });
  return fresh.access_token;
}
