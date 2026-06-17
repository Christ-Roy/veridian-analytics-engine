/**
 * GSC property — la liaison OAuth Google Search Console d'un workspace.
 *
 * Stockée dans la system DB ClickHouse (`gsc_property`), une row par workspace
 * (ORDER BY workspace_id, id ; ReplacingMergeTree(updated_at) pour les
 * upserts). Les tokens OAuth sont chiffrés AES-256-GCM avec une clé DÉRIVÉE
 * par workspace (`common/crypto.ts` : PBKDF2(master, workspace_id)) — plus sûr
 * que la clé globale unique du bridge legacy.
 *
 * Cycle de vie :
 *   1. oauth-callback → on échange le code, on chiffre les tokens, on liste les
 *      sites GSC du compte et on résout automatiquement le `site_url` (matché
 *      sur le domaine du workspace). ownership_state passe à `verified`.
 *   2. sync (@Cron) → on pull searchAnalytics.query et on persiste dans
 *      `gsc_daily`. `last_sync_at` est mis à jour.
 *   3. disconnect → soft-delete (deleted_at posé), le token chiffré est purgé.
 *
 * Si aucun site exploitable n'est trouvé après le consent, la property reste
 * `pending` avec `site_url=''` (l'UI propose alors un resync).
 */

export type GscOwnershipState = 'pending' | 'verified';

/** Tokens OAuth Google en clair (jamais persistés tels quels). */
export interface GscOauthTokens {
  access_token: string;
  refresh_token: string;
  /** ms epoch d'expiration de l'access_token. */
  expires_at: number;
  scope: string;
  token_type: 'Bearer';
}

/** Représentation interne d'une property (tokens chiffrés). */
export interface GscProperty {
  id: string;
  workspace_id: string;
  /** URL de la propriété GSC (`sc-domain:exemple.fr` ou `https://exemple.fr/`). */
  site_url: string;
  ownership_state: GscOwnershipState;
  /** Blob chiffré "iv:tag:ciphertext" de {@link GscOauthTokens}. */
  oauth_tokens_encrypted: string;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Vue publique exposée au front — aucun token, même chiffré. */
export interface PublicGscProperty {
  connected: boolean;
  site_url: string | null;
  ownership_state: GscOwnershipState | null;
  last_sync_at: string | null;
}
