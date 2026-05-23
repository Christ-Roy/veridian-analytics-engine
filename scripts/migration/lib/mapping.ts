/**
 * Mapping legacy `veridian-analytics` → bridge `veridian-analytics-engine`.
 *
 * Fonctions PURES de transformation — aucune I/O, aucun accès DB. Testées
 * en isolation par `veridian-bridge/tests/migration/*.test.ts`. C'est le
 * cœur "à risque" de la migration : un mauvais mapping = données corrompues
 * en prod. Tout passe par ici, rien d'inline dans les scripts orchestrateurs.
 *
 * Schémas concernés :
 *   legacy.analytics.GscDaily     → bridge.GscDaily
 *   legacy.analytics.GscProperty  → bridge.GscProperty
 *   legacy.analytics.FormSubmission → bridge.FormSubmission
 *   legacy.analytics.Lead         → bridge.Lead
 *   legacy.analytics.LeadSession  → bridge.LeadSession
 *   legacy.analytics.FormSchema   → bridge.FormSchema
 *   legacy.analytics.PushSubscription → bridge.PushSubscription
 *
 * PAS migré (décision Robert, ticket D2 §6) : Pageview, SipCall — staminads
 * démarre à J0 pour les pageviews.
 *
 * Différences de schéma clés gérées ici :
 *   - GscDaily : legacy `day` → bridge `date` ; legacy n'a pas `searchType`
 *     par défaut "" → bridge défaut "web".
 *   - GscProperty : legacy `propertyUrl` → bridge `siteUrl` ; legacy n'a pas
 *     `type` (SITE/DOMAIN) → on le dérive du préfixe de l'URL.
 *   - FormSubmission : legacy `formName`/`payload`/`path` → bridge
 *     `formSlug`/`data`/`pageUrl` ; legacy `visitorHash` n'existe pas comme
 *     `visitorId` → on porte `sessionId` tel quel.
 *   - Lead : legacy a `tenantId` ET `siteId` ; bridge n'a que `siteId`.
 *   - LeadSession : legacy `sessionId` requis ; bridge `sessionId` nullable.
 */

// ─── Types des rows LEGACY (sous-ensemble des colonnes utiles) ──────────────

export interface LegacyGscProperty {
  id: string;
  siteId: string;
  propertyUrl: string;
  lastSyncAt: Date | string | null;
}

export interface LegacyGscDaily {
  id: string;
  siteId: string;
  day: Date | string;
  query: string;
  page: string;
  country: string;
  device: string;
  searchType: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

// LegacyFormSchema / LegacyFormSubmission / LegacyLead / LeadSession /
// PushSubscription — types retirés 2026-05-23 (scope change cleanup).

// ─── Types des rows BRIDGE (shape Prisma `create`) ──────────────────────────

export interface BridgeGscPropertyCreate {
  id: string;
  tenantId: string;
  siteUrl: string;
  type: "SITE" | "DOMAIN";
  ownershipState: string;
  lastSyncAt: Date | null;
}

export interface BridgeGscDailyCreate {
  id: string;
  gscPropertyId: string;
  date: Date;
  query: string;
  page: string;
  country: string;
  device: string;
  searchType: string;
  impressions: number;
  clicks: number;
  position: number;
  ctr: number;
}

// BridgeFormSchemaCreate / FormSubmission / Lead / LeadSession /
// PushSubscription — types retirés 2026-05-23 (scope change cleanup).

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Normalise une valeur date (Date | ISO string) en Date. Throw si invalide. */
export function toDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid date value: ${String(value)}`);
  }
  return d;
}

/** Idem mais tolère null. */
export function toDateOrNull(value: Date | string | null): Date | null {
  return value == null ? null : toDate(value);
}

/**
 * Dérive le `type` GSC (SITE | DOMAIN) à partir de l'URL de propriété.
 * GSC : "sc-domain:exemple.fr" = DOMAIN property ; "https://..." = SITE.
 */
export function deriveGscPropertyType(propertyUrl: string): "SITE" | "DOMAIN" {
  return propertyUrl.startsWith("sc-domain:") ? "DOMAIN" : "SITE";
}

// ─── Transformations ────────────────────────────────────────────────────────

/**
 * GscProperty legacy → bridge. Le `tenantId` est celui du TENANT BRIDGE
 * (résolu via le mapping de siteKey, pas le tenantId legacy).
 * `ownershipState` est figé à "verified" : on ne migre que des propriétés
 * déjà fonctionnelles côté legacy.
 */
export function mapGscProperty(
  legacy: LegacyGscProperty,
  bridgeTenantId: string,
): BridgeGscPropertyCreate {
  return {
    id: legacy.id,
    tenantId: bridgeTenantId,
    siteUrl: legacy.propertyUrl,
    type: deriveGscPropertyType(legacy.propertyUrl),
    ownershipState: "verified",
    lastSyncAt: toDateOrNull(legacy.lastSyncAt),
  };
}

/**
 * GscDaily legacy → bridge. `day` → `date`. Le `gscPropertyId` est l'id de la
 * GscProperty bridge (= legacy.id, conservé par `mapGscProperty`).
 */
export function mapGscDaily(
  legacy: LegacyGscDaily,
  bridgeGscPropertyId: string,
): BridgeGscDailyCreate {
  return {
    id: legacy.id,
    gscPropertyId: bridgeGscPropertyId,
    date: toDate(legacy.day),
    query: legacy.query ?? "",
    page: legacy.page ?? "",
    country: legacy.country ?? "",
    device: legacy.device ?? "",
    searchType: legacy.searchType || "web",
    impressions: legacy.impressions ?? 0,
    clicks: legacy.clicks ?? 0,
    position: legacy.position ?? 0,
    ctr: legacy.ctr ?? 0,
  };
}

// mapFormSchema / mapFormSubmission / mapLead / mapLeadSession /
// mapPushSubscription — fonctions retirées 2026-05-23 (scope change : Forms
// supprimé, Push archivé). Les sites legacy n'ont plus de pipeline de
// migration de ces données — staminads démarre à J0 pour le nouveau scope.

// ─── visitor_id : génération déterministe pour la transition ────────────────

/**
 * Le patch staminads Phase 2 introduit un `visitor_id` stable côté tracker.
 * Pour les données HISTORIQUES (pré-migration) il n'y a pas de visitor_id —
 * on en dérive un DÉTERMINISTE à partir du sessionId legacy pour que la
 * réconciliation lead ↔ session reste possible.
 *
 * Déterministe = rejouer la migration recalcule le MÊME visitor_id (pré-requis
 * idempotence). Préfixe `vrd_legacy_` pour distinguer des visitor_id natifs.
 *
 * On n'utilise PAS de hash crypto (overkill) : le sessionId legacy est déjà
 * un cuid unique, on le préfixe simplement.
 */
export function deriveLegacyVisitorId(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return `vrd_legacy_${sessionId}`;
}
