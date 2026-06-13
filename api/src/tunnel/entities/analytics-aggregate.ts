/**
 * AnalyticsAggregate — the EXACT contract shape consumed by the tunnel bridge
 * (veridian-tunnel-de-vente/bridge/src/score-tunnel.ts:AnalyticsAggregate).
 *
 * 🔴 This is a CROSS-REPO CONTRACT (CONTRATS-TUNNEL §7). The bridge consumes it
 * as-is and feeds it into computeTunnelScore() alongside its own Notifuse
 * signals. Do NOT add/remove/rename a field without coordinating with the
 * tunnel agent — a drift breaks the score silently.
 *
 * The engine is the source of truth for THIS data (analytics only). It computes
 * the aggregate; it does NOT compute or write person.score (the bridge fuses
 * Notifuse + analytics and is the single score authority — §4c.4).
 *
 * `lastSeen` is serialized to an ISO string on the wire (Date|null in the bridge).
 */
export interface AnalyticsAggregate {
  /** audit slug OR normalized email (ClickHouse user_id, union of both keys). */
  userId: string;
  /** count of /audit/ page views (screen_view on /audit/ + audit_view goals). */
  auditViews: number;
  /** max scroll depth reached on /audit/ pages, 0-100. */
  auditScrollMax: number;
  /** unique hot pages visited (/tarifs, /contact, /roi). */
  hotPages: number;
  /** unique pages visited outside audit + outside hot pages. */
  otherPages: number;
  /** consent_granted goal seen (tracked, never scored — kept for the bridge). */
  consented: boolean;
  /** CTA goal clicks (audit_cta_rdv, appointment_click, roi_lead_click, cta_click). */
  ctaClicks: number;
  /** rdv_booked goals. */
  rdvBooked: number;
  /** the identity is an email (identify(email) happened) OR a Hub signup goal. */
  identifiedByEmail: boolean;
  /** a real SaaS app was started (Hub app_started, notifuse|prospection only). */
  appStarted: boolean;
  /** distinct sessions (return_visit +15 when >= 2). */
  sessions: number;
  /** most recent event time, ISO UTC string, or null. */
  lastSeen: string | null;
}
