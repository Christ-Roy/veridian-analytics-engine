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

export interface LegacyFormSchema {
  id: string;
  siteId: string;
  formName: string;
  fields: unknown;
}

export interface LegacyFormSubmission {
  id: string;
  siteId: string;
  formName: string;
  path: string | null;
  payload: unknown;
  email: string | null;
  phone: string | null;
  sessionId: string | null;
  leadId: string | null;
  createdAt: Date | string;
}

export interface LegacyLead {
  id: string;
  tenantId: string;
  siteId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
}

export interface LegacyLeadSession {
  id: string;
  leadId: string;
  sessionId: string;
  siteId: string;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  pageviewCount: number;
}

export interface LegacyPushSubscription {
  id: string;
  tenantId: string;
  siteId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date | string;
}

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

export interface BridgeFormSchemaCreate {
  id: string;
  siteId: string;
  formSlug: string;
  name: string;
  fields: unknown;
}

export interface BridgeFormSubmissionCreate {
  id: string;
  siteId: string;
  formSchemaId: string | null;
  formSlug: string;
  data: unknown;
  pageUrl: string | null;
  visitorId: string | null;
  sessionId: string | null;
  leadId: string | null;
  createdAt: Date;
}

export interface BridgeLeadCreate {
  id: string;
  siteId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface BridgeLeadSessionCreate {
  id: string;
  leadId: string;
  visitorId: string | null;
  sessionId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  pageviewCount: number;
}

export interface BridgePushSubscriptionCreate {
  id: string;
  tenantId: string;
  siteId: string | null;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
  visitorId: string | null;
  createdAt: Date;
}

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

/** FormSchema legacy → bridge. `formName` → `formSlug` + `name`. */
export function mapFormSchema(
  legacy: LegacyFormSchema,
  bridgeSiteId: string,
): BridgeFormSchemaCreate {
  return {
    id: legacy.id,
    siteId: bridgeSiteId,
    formSlug: legacy.formName,
    name: legacy.formName,
    fields: legacy.fields ?? [],
  };
}

/**
 * FormSubmission legacy → bridge. `formName` → `formSlug`, `payload` → `data`,
 * `path` → `pageUrl`. Le `leadId` est ré-écrit avec l'id du LEAD BRIDGE
 * (legacy.leadId conservé tel quel par `mapLead`, donc identité 1:1).
 */
export function mapFormSubmission(
  legacy: LegacyFormSubmission,
  bridgeSiteId: string,
  bridgeFormSchemaId: string | null,
): BridgeFormSubmissionCreate {
  return {
    id: legacy.id,
    siteId: bridgeSiteId,
    formSchemaId: bridgeFormSchemaId,
    formSlug: legacy.formName,
    data: legacy.payload ?? {},
    pageUrl: legacy.path,
    // Le tracker legacy n'a pas de visitor_id stable ; on ne porte que le
    // sessionId. Le visitor_id staminads démarre à J0 sur les nouveaux events.
    visitorId: null,
    sessionId: legacy.sessionId,
    leadId: legacy.leadId,
    createdAt: toDate(legacy.createdAt),
  };
}

/**
 * Lead legacy → bridge. Le bridge n'a pas de `tenantId` sur Lead (scope par
 * `siteId`). `submissionsCount` n'existe pas côté legacy → recalculé par le
 * script à partir du nombre de FormSubmission portées, défaut 1.
 */
export function mapLead(
  legacy: LegacyLead,
  bridgeSiteId: string,
): BridgeLeadCreate {
  return {
    id: legacy.id,
    siteId: bridgeSiteId,
    email: legacy.email,
    phone: legacy.phone,
    name: legacy.name,
    firstSeenAt: toDate(legacy.firstSeenAt),
    lastSeenAt: toDate(legacy.lastSeenAt),
  };
}

/**
 * LeadSession legacy → bridge. Legacy `sessionId` est requis ; bridge le
 * stocke comme `sessionId` ET on le réutilise comme `visitorId` faute de
 * mieux (le tracker legacy n'avait pas de visitor_id distinct). C'est cohérent
 * avec la sémantique : 1 session legacy = 1 visiteur identifiable.
 */
export function mapLeadSession(
  legacy: LegacyLeadSession,
): BridgeLeadSessionCreate {
  return {
    id: legacy.id,
    leadId: legacy.leadId,
    // Pas de visitor_id legacy : on retombe sur le sessionId comme clé visiteur.
    visitorId: legacy.sessionId,
    sessionId: legacy.sessionId,
    startedAt: toDate(legacy.firstSeenAt),
    endedAt: toDate(legacy.lastSeenAt),
    pageviewCount: legacy.pageviewCount ?? 1,
  };
}

/**
 * PushSubscription legacy → bridge. Legacy stocke `p256dh`/`auth` à plat ;
 * le bridge les groupe dans un JSON `keys`. L'`endpoint` est conservé tel
 * quel — c'est la clé unique globale, et les clés VAPID DOIVENT être
 * identiques entre legacy et bridge (cf. .env.example B2) pour que les
 * abonnements restent valides après migration.
 */
export function mapPushSubscription(
  legacy: LegacyPushSubscription,
  bridgeTenantId: string,
  bridgeSiteId: string | null,
): BridgePushSubscriptionCreate {
  return {
    id: legacy.id,
    tenantId: bridgeTenantId,
    siteId: bridgeSiteId,
    endpoint: legacy.endpoint,
    keys: { p256dh: legacy.p256dh, auth: legacy.auth },
    userAgent: legacy.userAgent,
    visitorId: null,
    createdAt: toDate(legacy.createdAt),
  };
}

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
