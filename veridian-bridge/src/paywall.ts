/**
 * Paywall — V1 stub.
 *
 * Bloque tout accès "écriture" pour les tenants en statut non-actif. La V1
 * se contente d'inspecter `tenant.status` :
 *   - active       → laisse passer
 *   - suspended    → 402 paywall_suspended
 *   - trial_expired → 402 paywall_trial_expired
 *   - soft_deleted → 402 paywall_soft_deleted
 *
 * V2 (ticket S3) ajoutera l'obfuscation field-level sur les reads + le
 * composant <BlurredText> côté UI. Pour l'instant on n'expose qu'un check
 * server-side qui lève une PaywallError standardisée.
 *
 * Source : CONTRAT-HUB §5.9.
 */

import type { TenantRecord, TenantStore } from "./hub/store.js";

export type PaywallReason =
  | "paywall_suspended"
  | "paywall_trial_expired"
  | "paywall_soft_deleted";

export class PaywallError extends Error {
  public readonly status = 402;
  public readonly code: PaywallReason;
  public readonly tenantId: string;

  constructor(tenantId: string, code: PaywallReason) {
    super(`Paywall: ${code} (tenant=${tenantId})`);
    this.code = code;
    this.tenantId = tenantId;
    this.name = "PaywallError";
  }
}

const STATUS_TO_REASON: Record<string, PaywallReason> = {
  suspended: "paywall_suspended",
  trial_expired: "paywall_trial_expired",
  soft_deleted: "paywall_soft_deleted",
};

/**
 * Bloque si le statut tenant n'est pas `active`. Throw PaywallError(402).
 *
 * Si le tenant n'existe pas, throw une erreur générique (404 doit être géré
 * par l'appelant — c'est pas du paywall, c'est de la résolution).
 */
export async function requireActivePlan(
  tenantId: string,
  store: TenantStore
): Promise<TenantRecord> {
  const tenant = await store.findById(tenantId);
  if (!tenant) {
    throw new Error(`tenant_not_found:${tenantId}`);
  }
  const reason = STATUS_TO_REASON[tenant.status];
  if (reason) {
    throw new PaywallError(tenantId, reason);
  }
  return tenant;
}

/**
 * Variante qui renvoie un boolean au lieu de throw — utile pour les
 * endpoints qui doivent "dégrader" plutôt que "refuser" (cf §5.9).
 */
export function isPlanActive(tenant: TenantRecord): boolean {
  return !STATUS_TO_REASON[tenant.status];
}
