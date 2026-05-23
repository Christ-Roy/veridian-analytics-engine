/**
 * Données de test reproductibles.
 *
 * RÈGLE D'OR : tout ce qui est créé contre une cible LIVE doit utiliser le
 * préfixe `e2e-test-` pour pouvoir être nettoyé par grep dans la DB.
 * Les emails sont sur le TLD `.veridian-test.local` (jamais routable, jamais
 * de risque d'envoyer un vrai mail).
 */

import { randomUUID } from "node:crypto";

/** Génère un suffixe random pour isoler les runs. */
export function testRunId(): string {
  return randomUUID().slice(0, 8);
}

/** ID de tenant Hub pour les tests E2E — TOUJOURS préfixé. */
export function makeTestTenantId(suffix?: string): string {
  return `hub_tnt_e2e_${suffix ?? testRunId()}`;
}

/** Workspace name garantie reconnaissable. */
export function makeTestWorkspaceName(suffix?: string): string {
  return `e2e-test-${suffix ?? testRunId()}`;
}

/** Email de test non routable. */
export function makeTestEmail(local?: string): string {
  return `e2e-test-${local ?? testRunId()}@veridian-test.local`;
}

/** User ID Hub format. */
export function makeTestUserId(suffix?: string): string {
  return `hub_usr_e2e_${suffix ?? testRunId()}`;
}

/** Payload provision Hub valide (CONTRAT-HUB §5.1). */
export interface ProvisionPayload {
  tenant_id: string;
  workspace_name: string;
  owner_email: string;
  plan: "free" | "pro" | "business" | "enterprise";
}

export function makeProvisionPayload(
  override: Partial<ProvisionPayload> = {},
): ProvisionPayload {
  const id = testRunId();
  return {
    tenant_id: `hub_tnt_e2e_${id}`,
    workspace_name: `e2e-test-${id}`,
    owner_email: `e2e-test-${id}@veridian-test.local`,
    plan: "free",
    ...override,
  };
}

/** Payload attach-owner valide (CONTRAT-HUB §5.3). */
export interface AttachOwnerPayload {
  tenant_id: string;
  user_email: string;
  user_id: string;
}

export function makeAttachOwnerPayload(
  override: Partial<AttachOwnerPayload> = {},
): AttachOwnerPayload {
  const id = testRunId();
  return {
    tenant_id: `hub_tnt_e2e_${id}`,
    user_email: `e2e-test-${id}@veridian-test.local`,
    user_id: `hub_usr_e2e_${id}`,
    ...override,
  };
}

/** Services connus côté bridge (validation shadow-marketing). */
export const KNOWN_SHADOW_SERVICES = [
  "calls",
  "forms",
  "pageviews",
  "gsc",
  "ads",
  "pagespeed",
] as const;

export const KNOWN_SHADOW_ICONS = [
  "phone",
  "inbox",
  "line-chart",
  "search",
  "megaphone",
  "gauge",
] as const;
