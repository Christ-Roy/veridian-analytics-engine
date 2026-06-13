import { Injectable } from '@nestjs/common';
import { deterministicTimelineId } from './deterministic-id';

/**
 * TwentyEventMapper — pure mapping of a tracked analytics event onto a Twenty
 * timeline activity name + the identity used to resolve the target Person.
 *
 * The QUOI is frozen by CONTRATS-TUNNEL §4c.3 ("namespace.verbe", digests only,
 * never the raw goal stream) and §4a ("the bridge alone maps raw goal names →
 * timeline names; the site never knows Twenty's names, Twenty never knows the
 * site's goal names"). This class is the engine-native re-implementation of the
 * mapping that lived in the micro-service `bridge/src/analytics-pull.ts`.
 *
 * Stateless, no I/O — safe to unit-test in isolation.
 *
 * Input shape = the `event.tracked` payload emitted by
 * `events/session-payload.handler.ts#emitTracked`:
 *   { workspace_id, event_type, event_id, payload: {
 *       path, goal_name, goal_value, properties, user_id, utm, … } }
 */

/** Twenty timeline activity names — frozen §4c.3 (analytics namespace). */
export type TwentyTimelineName =
  | 'audit.page_view'
  | 'audit.scroll'
  | 'audit.cta_click'
  | 'audit.rdv'
  | 'signup'
  | 'app.started'
  | 'score.threshold';

/**
 * Raw goal names emitted by the site (terrain site-audit 2026-06-10). The
 * mapping to §4c.3 timeline names happens HERE — the site keeps its own names.
 */
const CTA_GOALS = new Set([
  'audit_cta_rdv',
  'appointment_click',
  'roi_lead_click',
  'cta_click',
]);
const RDV_GOALS = new Set(['rdv_booked']);
const AUDIT_VIEW_GOALS = new Set(['audit_view', 'audit_page_view']);
const AUDIT_SCROLL_GOALS = new Set(['audit_scroll', 'scroll_depth']);

/** Hub goals (contrat §4a-bis). */
const SIGNUP_GOALS = new Set(['signup']);
const APP_STARTED_GOALS = new Set(['app_started']);

/**
 * Only these `properties.app` values earn an `app.started` milestone
 * (whitelist frozen §4a-bis). `roi-calculator` (site source) is EXCLUDED —
 * already covered by the hot-page (/roi) + CTA signals.
 */
const APP_STARTED_TIMELINE_APPS = new Set(['notifuse', 'prospection']);

/** Scroll depth (%) above which a /audit/ view counts as a `audit.scroll`. */
const AUDIT_SCROLL_THRESHOLD = 75;

export interface TrackedEventContext {
  workspace_id: string;
  event_type: string; // 'screen_view' | 'goal' | … (engine event.name)
  event_id: string;
  payload: Record<string, unknown>;
}

export interface MappedTimelineEvent {
  /**
   * Deterministic Twenty activity id (UUIDv5 = f(eventId, name)). A replay of
   * the same (event, milestone) yields the SAME id → Twenty no-ops →
   * exactly-once with no engine-side store (task #9).
   */
  id: string;
  /** Frozen timeline name §4c.3 (the activity `name`). */
  name: TwentyTimelineName;
  /**
   * Identity used to resolve the Person §4c.1:
   *   - an email (contains '@') → emails.primaryEmail
   *   - otherwise an audit slug → auditSlug
   * Comes from the event's user_id (identify(slug) then identify(email), §4a).
   */
  identity: string;
  /** True heure de l'event ISO UTC §4c.2 — jamais l'heure d'écriture. */
  happensAt: string;
  /** Stable id of the underlying tracked event — used for delivery dedup. */
  eventId: string;
  /** Extra timeline properties (audit trail §4.3). */
  properties: Record<string, unknown>;
}

@Injectable()
export class TwentyEventMapper {
  /**
   * Map a tracked event to a timeline activity, or null when the event is
   * not a milestone (raw stream noise, unknown goal, missing identity).
   *
   * Returning null is the common case: most tracked events do NOT become a
   * Twenty timeline entry (only digests/milestones do, §4c.3).
   */
  map(event: TrackedEventContext): MappedTimelineEvent | null {
    const p = event.payload ?? {};
    const identity = this.normalizeIdentity(p.user_id);
    if (!identity) return null; // no identity → no Person to attach to

    const name = this.resolveName(event.event_type, p);
    if (!name) return null;

    const happensAt = this.resolveHappensAt(p);
    return {
      id: deterministicTimelineId(event.event_id, name),
      name,
      identity,
      happensAt,
      eventId: event.event_id,
      properties: this.buildProperties(event, p),
    };
  }

  /**
   * Resolve the timeline name from the raw event. screen_view on a /audit/
   * path → audit.page_view (+ audit.scroll when deep). goal → mapped by name.
   */
  private resolveName(
    eventType: string,
    p: Record<string, unknown>,
  ): TwentyTimelineName | null {
    if (eventType === 'screen_view') {
      const path = String(p.path ?? '');
      if (path.startsWith('/audit/')) {
        // A deep audit view is a stronger signal than a shallow one. We surface
        // the scroll milestone when the recorded max_scroll crosses the bar;
        // otherwise the plain page_view milestone.
        const scroll = this.coerceNumber(
          (p as { max_scroll?: unknown }).max_scroll ?? p.scroll,
        );
        if (scroll !== null && scroll >= AUDIT_SCROLL_THRESHOLD) {
          return 'audit.scroll';
        }
        return 'audit.page_view';
      }
      // Non-audit page views are not timeline milestones (§4c.3).
      return null;
    }

    if (eventType === 'goal') {
      const goal = String(p.goal_name ?? '');
      if (AUDIT_VIEW_GOALS.has(goal)) return 'audit.page_view';
      if (AUDIT_SCROLL_GOALS.has(goal)) {
        const depth = this.coerceNumber(
          (p.properties as Record<string, unknown> | undefined)?.depth,
        );
        return depth !== null && depth >= AUDIT_SCROLL_THRESHOLD
          ? 'audit.scroll'
          : null;
      }
      if (CTA_GOALS.has(goal)) return 'audit.cta_click';
      if (RDV_GOALS.has(goal)) return 'audit.rdv';
      if (SIGNUP_GOALS.has(goal)) return 'signup';
      if (APP_STARTED_GOALS.has(goal)) {
        const app = String(
          (p.properties as Record<string, unknown> | undefined)?.app ?? '',
        );
        return APP_STARTED_TIMELINE_APPS.has(app) ? 'app.started' : null;
      }
      // Unknown goal → not a timeline milestone.
      return null;
    }

    return null;
  }

  /**
   * Identity normalization §4a/§4c.1. Emails are lowercased + trimmed so the
   * union slug↔email and the Person lookup are stable. A slug is passed
   * through verbatim (the secret-derived suffix is case-sensitive).
   */
  normalizeIdentity(userId: unknown): string | null {
    if (typeof userId !== 'string') return null;
    const trimmed = userId.trim();
    if (!trimmed) return null;
    return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed;
  }

  /**
   * happensAt §4c.2 — the TRUE event time, ISO UTC, milliseconds max.
   * Twenty rejects micro-precision timestamps with a 400 that would fail the
   * whole batch of 60, so we always normalize through Date#toISOString().
   * Falls back to now() only when no usable timestamp is present.
   */
  private resolveHappensAt(p: Record<string, unknown>): string {
    const candidates = [
      (p as { goal_timestamp?: unknown }).goal_timestamp,
      (p as { event_timestamp?: unknown }).event_timestamp,
      (p as { entered_at?: unknown }).entered_at,
      (p as { received_at?: unknown }).received_at,
    ];
    for (const c of candidates) {
      const iso = this.toIsoOrNull(c);
      if (iso) return iso;
    }
    return new Date().toISOString();
  }

  private buildProperties(
    event: TrackedEventContext,
    p: Record<string, unknown>,
  ): Record<string, unknown> {
    const props: Record<string, unknown> = {
      // Audit trail §4.3 — duplicates detectable, replay verifiable.
      eventId: event.event_id,
      source: 'analytics',
    };
    if (p.path) props.url = p.path;
    if (p.goal_name) props.goalName = p.goal_name;
    const utm = p.utm as Record<string, unknown> | undefined;
    if (utm?.source) props.utmSource = utm.source;
    if (utm?.campaign) props.utmCampaign = utm.campaign;
    return props;
  }

  /** Accept ClickHouse "YYYY-MM-DD HH:MM:SS.SSS", ISO, or epoch ms/number. */
  private toIsoOrNull(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const s = String(value);
    const normalized = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  private coerceNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
}
