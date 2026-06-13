/**
 * TwentyBudget — sliding-minute token bucket shared across a connector flush.
 *
 * Twenty's REST API caps at ~100 req/min (§4c.2). Every Twenty HTTP call
 * (Person resolution, batch timeline, score PATCH) takes one token. When the
 * bucket is empty the caller backs off — the work is NOT dropped, it is left
 * pending for the next worker tick (cf delivery worker retry semantics).
 *
 * Priority order is enforced by the CALLER (timeline flush before score push,
 * writer.ts §4.1), not here — this is a dumb counter.
 *
 * Pure, no I/O, deterministic with an injectable clock for tests.
 */
export class TwentyBudget {
  private windowStart = 0;
  private used = 0;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(limitPerMin = 100, now: () => number = Date.now) {
    this.limit = limitPerMin;
    this.now = now;
  }

  /** Take one token. Returns false when the minute budget is exhausted. */
  take(): boolean {
    const t = this.now();
    if (t - this.windowStart >= 60_000) {
      this.windowStart = t;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }

  /** Tokens left in the current window (for observability / tests). */
  remaining(): number {
    const t = this.now();
    if (t - this.windowStart >= 60_000) return this.limit;
    return Math.max(0, this.limit - this.used);
  }
}
