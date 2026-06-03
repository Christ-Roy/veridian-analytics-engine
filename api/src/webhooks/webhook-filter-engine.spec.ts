import { WebhookFilterEngine } from './webhook-filter-engine';
import type { WebhookFilter } from './entities/webhook-definition.entity';

describe('WebhookFilterEngine', () => {
  let engine: WebhookFilterEngine;
  beforeEach(() => {
    engine = new WebhookFilterEngine();
  });

  describe('empty filter array', () => {
    it('matches all events', () => {
      expect(engine.matches([], { anything: 'goes' })).toBe(true);
    });
  });

  describe('equals operator', () => {
    it('matches a top-level field', () => {
      const filters: WebhookFilter[] = [{ field: 'path', op: 'equals', value: '/contact' }];
      expect(engine.matches(filters, { path: '/contact' })).toBe(true);
      expect(engine.matches(filters, { path: '/home' })).toBe(false);
    });

    it('matches a nested field (utm.source)', () => {
      const filters: WebhookFilter[] = [
        { field: 'utm.source', op: 'equals', value: 'google_ads' },
      ];
      expect(engine.matches(filters, { utm: { source: 'google_ads' } })).toBe(true);
      expect(engine.matches(filters, { utm: { source: 'facebook' } })).toBe(false);
    });

    it('uses string coercion (number vs numeric-string)', () => {
      const filters: WebhookFilter[] = [{ field: 'score', op: 'equals', value: 80 }];
      expect(engine.matches(filters, { score: '80' })).toBe(true);
      expect(engine.matches(filters, { score: 80 })).toBe(true);
    });

    it('returns false when the field is missing', () => {
      const filters: WebhookFilter[] = [{ field: 'path', op: 'equals', value: '/x' }];
      expect(engine.matches(filters, {})).toBe(false);
    });
  });

  describe('matches operator (regex)', () => {
    it('matches with a valid regex', () => {
      const filters: WebhookFilter[] = [
        { field: 'path', op: 'matches', value: '^/(audit|pricing|contact)$' },
      ];
      expect(engine.matches(filters, { path: '/contact' })).toBe(true);
      expect(engine.matches(filters, { path: '/about' })).toBe(false);
    });

    it('returns false for non-string fields', () => {
      const filters: WebhookFilter[] = [{ field: 'score', op: 'matches', value: '^\\d+$' }];
      expect(engine.matches(filters, { score: 42 })).toBe(false);
    });

    it('returns false for a malformed regex (does not throw)', () => {
      const filters: WebhookFilter[] = [{ field: 'path', op: 'matches', value: '(' }];
      expect(engine.matches(filters, { path: '/anything' })).toBe(false);
    });
  });

  describe('in operator', () => {
    it('matches when the field value is in the array', () => {
      const filters: WebhookFilter[] = [
        { field: 'event_type', op: 'in', value: ['identify', 'pageview', 'form_submission'] },
      ];
      expect(engine.matches(filters, { event_type: 'identify' })).toBe(true);
      expect(engine.matches(filters, { event_type: 'whatever' })).toBe(false);
    });

    it('returns false when value is not an array', () => {
      const filters: WebhookFilter[] = [{ field: 'x', op: 'in', value: 'oops' as unknown as string[] }];
      expect(engine.matches(filters, { x: 'oops' })).toBe(false);
    });
  });

  describe('gt / lt operators', () => {
    it('compares numeric scores', () => {
      const gt: WebhookFilter[] = [{ field: 'props.score', op: 'gt', value: 80 }];
      expect(engine.matches(gt, { props: { score: 90 } })).toBe(true);
      expect(engine.matches(gt, { props: { score: 70 } })).toBe(false);
      expect(engine.matches(gt, { props: { score: 80 } })).toBe(false);

      const lt: WebhookFilter[] = [{ field: 'props.score', op: 'lt', value: 50 }];
      expect(engine.matches(lt, { props: { score: 40 } })).toBe(true);
      expect(engine.matches(lt, { props: { score: 60 } })).toBe(false);
    });

    it('returns false when comparing non-coercible values', () => {
      const filters: WebhookFilter[] = [{ field: 'x', op: 'gt', value: 5 }];
      expect(engine.matches(filters, { x: 'oui' })).toBe(false);
      expect(engine.matches(filters, {})).toBe(false);
    });
  });

  describe('multiple filters (AND)', () => {
    it('requires every filter to pass', () => {
      const filters: WebhookFilter[] = [
        { field: 'event_type', op: 'equals', value: 'goal' },
        { field: 'utm.source', op: 'equals', value: 'google_ads' },
      ];
      expect(
        engine.matches(filters, { event_type: 'goal', utm: { source: 'google_ads' } }),
      ).toBe(true);
      expect(
        engine.matches(filters, { event_type: 'goal', utm: { source: 'facebook' } }),
      ).toBe(false);
    });
  });

  describe('resolveField', () => {
    it('walks dotted paths', () => {
      expect(engine.resolveField({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    });
    it('returns undefined for missing paths', () => {
      expect(engine.resolveField({}, 'a.b.c')).toBeUndefined();
    });
    it('handles non-object intermediates', () => {
      expect(engine.resolveField({ a: 'string' }, 'a.b')).toBeUndefined();
    });
  });
});
