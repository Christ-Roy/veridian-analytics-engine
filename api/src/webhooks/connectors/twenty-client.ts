import { Logger } from '@nestjs/common';

/**
 * TwentyClient — engine-native re-implementation of the micro-service
 * `bridge/src/twenty-client.ts` TIMELINE path. The QUOI is frozen by
 * CONTRATS-TUNNEL §4c; this class is pure I/O against the Twenty REST API.
 *
 * ⚠️ SCOPE: timeline activities ONLY. The engine NEVER writes person.score —
 * the bridge tunnel is the single authority for the score (it fuses Notifuse
 * signals + uses a compare-and-set). Adding a patchPerson(score) here would
 * (a) break the "2 clics = 30 = chaud" invariant (engine has no Notifuse data)
 * and (b) create a double-writer lost-update. Frozen team-lead decision —
 * see CONTRATS-TUNNEL §4c.4 + task #5. Do NOT add a score write here.
 *
 * Multi-tenant by construction: it is instantiated PER WEBHOOK with that
 * workspace's own base URL + decrypted Bearer. No shared singleton, no cross-
 * tenant secret bleed.
 *
 * DRY_RUN (gate E2E à blanc, §6.7): READS stay real (Person resolution must
 * work to prove the mapping), MUTATIONS are logged instead of sent. Exactly
 * what the gate validates before flipping to real writes.
 */

export interface TwentyClientConfig {
  /** Twenty REST base URL, e.g. https://crm.app.veridian.site */
  baseUrl: string;
  /** Decrypted Bearer token for this workspace's Twenty API key. */
  bearer: string;
  /** When true, mutations are logged not sent. Resolution stays real. */
  dryRun: boolean;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

/** Timeline activity payload §4c.2. */
export interface TimelineActivityInput {
  /**
   * Deterministic client-supplied id (UUIDv5 = f(event_id, name)). Makes a
   * replay land on the SAME Twenty row → exactly-once, no engine-side store
   * (task #9). Twenty accepts a client id; on a duplicate it returns 400
   * "A duplicate entry was detected" (NOT 409 — verified by the E2E RUN, #12)
   * which batchTimeline treats as a no-op.
   */
  id: string;
  name: string; // frozen §4c.3: audit.* | signup | app.started | score.threshold
  happensAt: string; // ISO UTC — true event time, never the write time
  targetPersonId: string;
  properties: Record<string, unknown>;
}

export interface ResolvedPerson {
  id: string;
  doNotContact: boolean;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BATCH = 60; // §4c.2

export class TwentyClient {
  private readonly logger = new Logger(TwentyClient.name);
  private readonly config: TwentyClientConfig;

  constructor(config: TwentyClientConfig) {
    this.config = config;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.bearer}`,
      'Content-Type': 'application/json',
    };
  }

  private get timeout(): number {
    return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** §4c.1: email → emails.primaryEmail[eq]. */
  async resolveByEmail(email: string): Promise<ResolvedPerson | null> {
    return this.resolve(`emails.primaryEmail[eq]:"${this.escape(email)}"`);
  }

  /** §4c.1: slug → auditSlug[eq]. */
  async resolveBySlug(slug: string): Promise<ResolvedPerson | null> {
    return this.resolve(`auditSlug[eq]:"${this.escape(slug)}"`);
  }

  /**
   * Resolve a Person by the FORM of the identity (email vs slug), §4c.1.
   * A user_id becomes an email after identify(email) (§4a) so we branch on
   * the value's shape, never on the event source.
   */
  async resolvePerson(identity: string): Promise<ResolvedPerson | null> {
    return identity.includes('@')
      ? this.resolveByEmail(identity)
      : this.resolveBySlug(identity);
  }

  private async resolve(filter: string): Promise<ResolvedPerson | null> {
    const url = new URL('/rest/people', this.config.baseUrl);
    url.searchParams.set('filter', filter);
    url.searchParams.set('limit', '1');
    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      throw new Error(`Twenty resolve ${res.status}: ${await this.safeText(res)}`);
    }
    const body = (await res.json()) as {
      data?: { people?: Array<Record<string, unknown>> };
    };
    const person = body.data?.people?.[0];
    if (!person) return null;
    return {
      id: String(person.id),
      doNotContact: Boolean(person.doNotContact),
    };
  }

  /** §4c.2: POST /rest/batch/timelineActivities, ≤60 per call. */
  async batchTimeline(items: TimelineActivityInput[]): Promise<void> {
    if (items.length === 0) return;
    if (items.length > MAX_BATCH) {
      throw new Error(`batchTimeline: ${items.length} > ${MAX_BATCH} (§4c.2)`);
    }
    if (this.config.dryRun) {
      this.logger.log(
        `[DRY_RUN] POST /rest/batch/timelineActivities ×${items.length}`,
      );
      return;
    }
    const res = await fetch(
      new URL('/rest/batch/timelineActivities', this.config.baseUrl),
      {
        method: 'POST',
        headers: this.headers,
        // Each item carries its deterministic `id` (spread via ...i) so a
        // replay reuses the same Twenty row → exactly-once.
        body: JSON.stringify(
          items.map((i) => ({ ...i, createdBy: { source: 'API' } })),
        ),
        signal: AbortSignal.timeout(this.timeout),
      },
    );
    if (res.ok) return;

    // Read the error body ONCE (a Response body is single-use) — reused both
    // for the duplicate test and the thrown message.
    const body = await this.safeText(res);

    // Duplicate of an already-written deterministic id → replay no-op
    // (exactly-once). The real Twenty REPLAY returns 400 "A duplicate entry
    // was detected" (NOT 409, despite REST conventions) — verified by the E2E
    // RUN. We accept BOTH: 409, or 400 whose body mentions "duplicate".
    if (res.status === 409 || (res.status === 400 && /duplicate/i.test(body))) {
      this.logger.debug(
        `batchTimeline: duplicate (HTTP ${res.status}, id already present) — no-op exactly-once`,
      );
      return;
    }

    throw new Error(`Twenty batchTimeline ${res.status}: ${body}`);
  }

  // NOTE: no patchPerson() — the engine never writes person.score (the bridge
  // is the single score authority). Cf class header + CONTRATS-TUNNEL §4c.4.

  /** Health probe used by the connector before a flush. */
  async reachable(): Promise<boolean> {
    try {
      const res = await fetch(
        new URL('/rest/people?limit=1', this.config.baseUrl),
        { headers: this.headers, signal: AbortSignal.timeout(5_000) },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Escape a double quote so it cannot break the Twenty filter grammar. */
  private escape(value: string): string {
    return value.replace(/"/g, '\\"');
  }

  private async safeText(res: Response): Promise<string> {
    try {
      return (await res.text()).slice(0, 500);
    } catch {
      return '';
    }
  }
}
