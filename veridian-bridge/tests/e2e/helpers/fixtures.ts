/**
 * Fixtures de données pour les tests E2E promise-flows.
 *
 * Centralise les payloads "happy path" pour que chaque spec puisse les
 * importer sans dupliquer. Si un endpoint évolue côté contrat Hub, on
 * met à jour ici une fois.
 */

// Payload pour POST /api/tenants/provision (CONTRAT-HUB §5.1).
// Format snake_case côté wire, cf src/hub/provision.ts ProvisionSchema.
export const VALID_PROVISION_PAYLOAD = {
  tenant_id: "hub_tnt_e2e_01",
  workspace_name: "Acme E2E",
  owner_email: "owner@acme-e2e.test",
  plan: "free" as const,
};

// Payload pour POST /api/tenants/attach-owner (CONTRAT-HUB §5.3).
export const VALID_ATTACH_OWNER_PAYLOAD = {
  tenant_id: "hub_tnt_e2e_01",
  user_email: "owner@acme-e2e.test",
  user_id: "hub_usr_e2e_01",
};

export const VALID_FORM_SUBMISSION_PAYLOAD = {
  siteKey: "acme-e2e-sitekey-01",
  fields: {
    name: "Jean Dupont",
    email: "jean.dupont@example.com",
    phone: "+33612345678",
    message: "Bonjour, je suis intéressé par vos services.",
  },
  url: "https://acme-e2e.test/contact",
  userAgent: "Mozilla/5.0 (E2E Test)",
};

// Doit matcher src/tenant-status.ts ServiceKey (6 services KNOWN_SERVICES)
export const KNOWN_SHADOW_SERVICES = [
  "calls",
  "forms",
  "pageviews",
  "gsc",
  "ads",
  "pagespeed",
] as const;

// Doit matcher src/shadow-marketing.ts ShadowIconKey
export const KNOWN_SHADOW_ICONS = [
  "phone",
  "inbox",
  "line-chart",
  "search",
  "megaphone",
  "gauge",
] as const;
