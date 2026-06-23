import { Injectable } from '@nestjs/common';
import type { WebhookFilter } from './entities/webhook-definition.entity';

/**
 * ReDoS hardening for the `matches` operator. The regex is operator-supplied
 * and runs on the shared event loop (hot ingestion path), so a catastrophic
 * pattern like `(a+)+$` against a long input could pin the loop and DoS
 * ingestion for ALL tenants. We have no native re2 dep, so we cap both sides:
 *   - the pattern source length (a tiny pattern can't blow up much)
 *   - the input length fed to .test() (backtracking cost scales with input)
 * Anything over the cap fails closed (never matches) rather than running.
 */
const MAX_REGEX_PATTERN_LENGTH = 512;
const MAX_REGEX_INPUT_LENGTH = 4_096;

/**
 * WebhookFilterEngine — pure stateless evaluator.
 *
 * Operators (Phase 1):
 *   - equals  : strict equality (case-sensitive for strings, value coerced)
 *   - matches : RegExp test on string field
 *   - in      : array contains
 *   - gt / lt : numeric strict comparison (NaN values fail open / never match)
 *
 * Multiple filters in the array are combined with logical AND
 * (cf PATTERNS-WEBHOOKS.md §5 — Phase 2 will add filter groups + OR).
 *
 * Field paths support dotted access (e.g. `utm.source`, `props.score`).
 * Missing fields → equals/matches/in/gt/lt all evaluate to false.
 */
@Injectable()
export class WebhookFilterEngine {
  /**
   * Return true iff the event satisfies every filter.
   * Empty filters array → match all events.
   */
  matches(filters: WebhookFilter[], event: Record<string, unknown>): boolean {
    if (!filters || filters.length === 0) return true;
    for (const filter of filters) {
      if (!this.evaluateOne(filter, event)) return false;
    }
    return true;
  }

  private evaluateOne(filter: WebhookFilter, event: Record<string, unknown>): boolean {
    const fieldValue = this.resolveField(event, filter.field);

    switch (filter.op) {
      case 'equals':
        return this.equalsLoose(fieldValue, filter.value);

      case 'matches': {
        if (typeof fieldValue !== 'string') return false;
        if (typeof filter.value !== 'string') return false;
        // ReDoS guard: cap pattern + input length. An over-long pattern or an
        // over-long input fails closed (never matches) instead of risking
        // catastrophic backtracking on the shared event loop.
        if (filter.value.length > MAX_REGEX_PATTERN_LENGTH) return false;
        if (fieldValue.length > MAX_REGEX_INPUT_LENGTH) return false;
        try {
          return new RegExp(filter.value).test(fieldValue);
        } catch {
          // malformed regex never matches
          return false;
        }
      }

      case 'in': {
        if (!Array.isArray(filter.value)) return false;
        return (filter.value as unknown[]).some((candidate) =>
          this.equalsLoose(fieldValue, candidate),
        );
      }

      case 'gt': {
        const fn = this.coerceNumber(fieldValue);
        const tn = this.coerceNumber(filter.value);
        if (fn === null || tn === null) return false;
        return fn > tn;
      }

      case 'lt': {
        const fn = this.coerceNumber(fieldValue);
        const tn = this.coerceNumber(filter.value);
        if (fn === null || tn === null) return false;
        return fn < tn;
      }

      default:
        return false;
    }
  }

  /** Dotted-path resolver. `utm.source` walks into nested objects. */
  resolveField(source: Record<string, unknown>, path: string): unknown {
    if (!path) return undefined;
    const segments = path.split('.');
    let cursor: unknown = source;
    for (const segment of segments) {
      if (cursor === null || cursor === undefined) return undefined;
      if (typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  }

  private equalsLoose(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) {
      return false;
    }
    // Same string repr → match (covers number↔numeric-string).
    return String(a) === String(b);
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
