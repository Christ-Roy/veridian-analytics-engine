import { BadRequestException } from '@nestjs/common';
import { WebhookTransformEngine } from './webhook-transform-engine';

describe('WebhookTransformEngine', () => {
  let engine: WebhookTransformEngine;

  beforeEach(() => {
    engine = new WebhookTransformEngine();
  });

  describe('render', () => {
    it('passthrough returns JSON.stringify(event)', () => {
      const event = { event_type: 'goal', score: 90 };
      expect(engine.render({ type: 'passthrough' }, event)).toBe(JSON.stringify(event));
    });

    it('null transform also returns JSON.stringify(event)', () => {
      const event = { foo: 'bar' };
      expect(engine.render(null, event)).toBe(JSON.stringify(event));
    });

    it('renders a Handlebars template with variables', () => {
      const out = engine.render(
        { type: 'template', template: 'source=veridian event={{event_type}} email={{email}}' },
        { event_type: 'identify', email: 'a@b.com' },
      );
      expect(out).toBe('source=veridian event=identify email=a@b.com');
    });

    it('supports the json helper', () => {
      const out = engine.render(
        { type: 'template', template: '{{json this}}' },
        { event_type: 'pageview', path: '/x' },
      );
      expect(JSON.parse(out)).toEqual({ event_type: 'pageview', path: '/x' });
    });

    it('supports the default helper', () => {
      const out = engine.render(
        { type: 'template', template: 'name={{default name "anonymous"}}' },
        {},
      );
      expect(out).toBe('name=anonymous');
    });

    it('supports the lowercase helper', () => {
      const out = engine.render(
        { type: 'template', template: '{{lowercase email}}' },
        { email: 'ROBERT@VERIDIAN.SITE' },
      );
      expect(out).toBe('robert@veridian.site');
    });

    it('throws BadRequestException(INVALID_TRANSFORM) on bad helper invocation', () => {
      // Handlebars by default tolerates missing variables (renders ''); we test a
      // truly broken template instead.
      const broken = { type: 'template' as const, template: '{{#each x' };
      expect(() => engine.render(broken, {})).toThrow(BadRequestException);
    });
  });

  describe('assertCompilable', () => {
    it('returns silently for valid templates', () => {
      expect(() =>
        engine.assertCompilable({ type: 'template', template: 'hello {{name}}' }),
      ).not.toThrow();
    });

    it('returns silently for passthrough / null', () => {
      expect(() => engine.assertCompilable({ type: 'passthrough' })).not.toThrow();
      expect(() => engine.assertCompilable(null)).not.toThrow();
    });

    it('throws on a malformed template', () => {
      expect(() =>
        engine.assertCompilable({ type: 'template', template: '{{#if x' }),
      ).toThrow(BadRequestException);
    });
  });
});
