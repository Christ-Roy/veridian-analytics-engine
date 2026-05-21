/**
 * GSC integration — barrel export.
 */

export {
  oauthBeginFlow,
  exchangeCode,
  refreshAccessToken,
  persistTokensForTenant,
  getAccessTokenForProperty,
  encryptTokens,
  decryptTokens,
  buildState,
  parseState,
  readOauthConfigFromEnv,
  OauthConfigError,
  OauthFlowError,
  GSC_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  type OauthConfig,
  type OauthTokens,
  type EncryptedBlob,
} from "./oauth.js";

export {
  syncProperty,
  syncAllVerified,
  querySearchAnalytics,
  parseRow,
  BULK_DIMENSIONS,
  GscApiError,
  type GscDimension,
  type GscSearchType,
  type GscRawRow,
  type SyncResult,
} from "./sync.js";

export {
  queryProperty,
  dashboardSummary,
  buildWhereFragments,
  type Dimension,
  type FilterOperator,
  type SearchType,
  type DimensionFilter,
  type QueryRequest,
  type QueryRow,
  type QueryResponse,
} from "./query.js";

import type { PrismaClient } from "@prisma/client";
import { exchangeCode, parseState, persistTokensForTenant, type OauthConfig } from "./oauth.js";

/**
 * High-level handler : appelé par le callback HTTP.
 * Valide le state, échange le code, persiste les tokens chiffrés.
 */
export async function oauthCallback(
  prisma: PrismaClient,
  code: string,
  state: string,
  cfg: OauthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tenantId: string }> {
  const tenantId = parseState(state, cfg.encryptionKey);
  const tokens = await exchangeCode(code, cfg, fetchImpl);
  await persistTokensForTenant(prisma, tenantId, tokens, cfg.encryptionKey);
  return { tenantId };
}
