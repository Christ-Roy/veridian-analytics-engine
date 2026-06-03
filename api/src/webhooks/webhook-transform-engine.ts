import { BadRequestException, Injectable } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import type { WebhookTransform } from './entities/webhook-definition.entity';

/**
 * WebhookTransformEngine — render the outbound HTTP body.
 *
 * - `passthrough` (or `null`): JSON.stringify(event) as the body.
 * - `template` : Handlebars template, rendered against the event context.
 *
 * Custom helpers (cf PATTERNS-WEBHOOKS.md §7):
 *   - {{json this}}            → JSON.stringify(this)
 *   - {{default email "x"}}    → email when truthy, else "x"
 *   - {{lowercase email}}      → email.toLowerCase()
 *
 * Handlebars is sandboxed — there is no eval, no I/O, no fs access.
 * Template strings are bounded to 64 KB by the DTO validator.
 */
@Injectable()
export class WebhookTransformEngine {
  private readonly handlebars: typeof Handlebars;

  constructor() {
    const instance = Handlebars.create();
    instance.registerHelper('json', (value: unknown) => {
      try {
        return new instance.SafeString(JSON.stringify(value));
      } catch {
        return new instance.SafeString('null');
      }
    });
    instance.registerHelper('default', (value: unknown, fallback: unknown) => {
      if (value === undefined || value === null || value === '') return fallback;
      return value;
    });
    instance.registerHelper('lowercase', (value: unknown) => {
      if (typeof value !== 'string') return '';
      return value.toLowerCase();
    });
    this.handlebars = instance;
  }

  /**
   * Render an outbound webhook body.
   * Defaults to `JSON.stringify(event)` when transform is null/passthrough.
   */
  render(transform: WebhookTransform, event: Record<string, unknown>): string {
    if (!transform || transform.type === 'passthrough') {
      return JSON.stringify(event);
    }
    if (transform.type === 'template') {
      try {
        const compiled = this.handlebars.compile(transform.template, {
          noEscape: false,
          strict: false,
        });
        return compiled(event);
      } catch (err) {
        throw new BadRequestException({
          code: 'INVALID_TRANSFORM',
          message: `Template render failed: ${(err as Error).message}`,
        });
      }
    }
    return JSON.stringify(event);
  }

  /**
   * Throw BadRequestException(INVALID_TRANSFORM) if the template cannot
   * be compiled. Used by the CRUD endpoints to catch typos before write.
   *
   * We force the parse step explicitly because Handlebars.compile() is
   * lazy — parse errors fire on execute, not on compile. Calling parse()
   * up front catches syntax errors at CRUD time instead of at first
   * delivery (when it would surface as a transform_failed delivery).
   */
  assertCompilable(transform: WebhookTransform): void {
    if (!transform || transform.type !== 'template') return;
    try {
      this.handlebars.parse(transform.template);
      this.handlebars.compile(transform.template, { strict: false });
    } catch (err) {
      throw new BadRequestException({
        code: 'INVALID_TRANSFORM',
        message: `Template compile failed: ${(err as Error).message}`,
      });
    }
  }
}
