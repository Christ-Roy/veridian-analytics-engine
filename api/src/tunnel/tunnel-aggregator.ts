import { AnalyticsAggregate } from './entities/analytics-aggregate';

/**
 * Pure analytics aggregation — engine-native port of the micro-service
 * `bridge/src/analytics-pull.ts:aggregateEvents`. No I/O, deterministic.
 *
 * Produces, per identity (ClickHouse user_id = slug OR normalized email), the
 * AnalyticsAggregate the bridge feeds into computeTunnelScore (§4a grille).
 * Milestone/timeline emission is NOT done here — that lives in the Twenty
 * connector (task #2). This module only computes the scoring aggregate (§5).
 *
 * Aggregation semantics mirror SCORING-V1.md §3 and the bridge exactly so the
 * "2 clics = 30 = chaud" invariant and the hot/other-page caps stay identical.
 */

/** Hot pages (grille V2). */
const HOT_PATHS = new Set(['/tarifs', '/contact', '/roi']);

/** Raw goal name → aggregate effect. Mirrors analytics-pull.ts. */
const CTA_GOALS = new Set([
  'audit_cta_rdv',
  'appointment_click',
  'roi_lead_click',
  'cta_click',
]);
const RDV_GOALS = new Set(['rdv_booked']);
const CONSENT_GOALS = new Set(['consent_granted']);
const AUDIT_VIEW_GOALS = new Set(['audit_view', 'audit_page_view']);
const AUDIT_SCROLL_GOALS = new Set(['audit_scroll', 'scroll_depth']);
const SIGNUP_GOALS = new Set(['signup']);
const APP_STARTED_GOALS = new Set(['app_started']);
/** Only real SaaS apps earn appStarted (§4a-bis whitelist). roi-calculator excluded. */
const APP_STARTED_SCORED_APPS = new Set(['notifuse', 'prospection']);

const AUDIT_SCROLL_THRESHOLD = 75;

/**
 * Raw event row read from ClickHouse `events`. Only the fields the aggregate
 * needs. `properties` is a ClickHouse Map(String,String) → object on read.
 */
export interface RawEventRow {
  user_id: string | null;
  session_id: string;
  name: string; // 'screen_view' | 'goal' | …
  path: string;
  max_scroll: number;
  goal_name: string;
  properties: Record<string, string>;
  goal_timestamp: string | null;
  updated_at: string;
}

/** Internal accumulator carrying the de-dup sets that don't ship on the wire. */
interface Acc {
  agg: AnalyticsAggregate;
  sessions: Set<string>;
  hot: Set<string>;
  other: Set<string>;
  lastSeen: Date | null;
}

/**
 * Fold a stream of raw events into per-identity aggregates. Stable across
 * pages: pass the same map back in to keep accumulating (cursor pagination).
 */
export function aggregateEvents(
  events: RawEventRow[],
  previous?: Map<string, Acc>,
): Map<string, Acc> {
  const out = previous ?? new Map<string, Acc>();

  for (const e of events) {
    const id = e.user_id;
    if (!id) continue; // anonymous events never enter the tunnel aggregate

    let acc = out.get(id);
    if (!acc) {
      acc = {
        agg: {
          userId: id,
          auditViews: 0,
          auditScrollMax: 0,
          hotPages: 0,
          otherPages: 0,
          consented: false,
          ctaClicks: 0,
          rdvBooked: 0,
          identifiedByEmail: id.includes('@'),
          appStarted: false,
          sessions: 0,
          lastSeen: null,
        },
        sessions: new Set(),
        hot: new Set(),
        other: new Set(),
        lastSeen: null,
      };
      out.set(id, acc);
    }
    const agg = acc.agg;

    acc.sessions.add(e.session_id);
    agg.sessions = acc.sessions.size;

    const eventDate = parseClickHouseDate(e.goal_timestamp ?? e.updated_at);
    if (eventDate && (!acc.lastSeen || eventDate > acc.lastSeen)) {
      acc.lastSeen = eventDate;
      agg.lastSeen = eventDate.toISOString();
    }

    if (e.name === 'screen_view') {
      if (e.path.startsWith('/audit/')) {
        agg.auditViews += 1;
        if (e.max_scroll > agg.auditScrollMax) agg.auditScrollMax = e.max_scroll;
      } else if (HOT_PATHS.has(e.path)) {
        acc.hot.add(e.path);
        agg.hotPages = acc.hot.size;
      } else {
        acc.other.add(e.path);
        agg.otherPages = acc.other.size;
      }
    } else if (e.name === 'goal') {
      const goal = e.goal_name;
      if (AUDIT_VIEW_GOALS.has(goal)) {
        agg.auditViews += agg.auditViews === 0 ? 1 : 0;
      } else if (AUDIT_SCROLL_GOALS.has(goal)) {
        const depth = Number(e.properties?.depth ?? 0);
        if (depth > agg.auditScrollMax) agg.auditScrollMax = depth;
      } else if (CTA_GOALS.has(goal)) {
        agg.ctaClicks += 1;
      } else if (RDV_GOALS.has(goal)) {
        agg.rdvBooked += 1;
      } else if (CONSENT_GOALS.has(goal)) {
        agg.consented = true; // tracked, never scored (lead decision)
      } else if (SIGNUP_GOALS.has(goal)) {
        agg.identifiedByEmail = true; // Hub signup → strong identification
      } else if (APP_STARTED_GOALS.has(goal)) {
        // +appStarted only for real SaaS apps (§4a-bis whitelist).
        if (APP_STARTED_SCORED_APPS.has(String(e.properties?.app ?? ''))) {
          agg.appStarted = true;
        }
      }
      // unknown goal: ignored for scoring (still stored engine-side).
    }
  }
  return out;
}

/** Extract the wire-ready aggregates (drops the internal de-dup sets). */
export function toAggregates(map: Map<string, Acc>): AnalyticsAggregate[] {
  return Array.from(map.values()).map((a) => a.agg);
}

/** "2026-06-10 11:36:52.498" (ClickHouse) or ISO → Date. */
function parseClickHouseDate(s: string | null): Date | null {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type { Acc as AggregateAccumulator };
