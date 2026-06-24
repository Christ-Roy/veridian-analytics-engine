import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * Closed list of configurable native dashboard widget keys (N3 layout).
 *
 * MUST stay in sync with the console source of truth
 * `console/src/components/dashboard/dashboard-layout.ts::DASHBOARD_WIDGET_KEYS`.
 * The front renders a fixed grid of native staminads widgets; `setLayout` only
 * REORDERS/HIDES these existing keys (no custom widget). An `order`/`hide` value
 * naming an unknown key used to be silently accepted (write 200, persisted) and
 * the front just ignored it → a typo'd `order` produced a silently broken layout
 * (ticket 2026-06-24-validation-currency-e164-layout-trous §3).
 *
 * Duplicated here (not imported) on purpose: the api/ package must not depend on
 * console/ source. 8 stable keys, changed maybe twice a year — a sync comment is
 * the right cost, not a build-time coupling.
 */
export const DASHBOARD_WIDGET_KEYS = [
  'pages',
  'sources',
  'campaigns',
  'countries',
  'heatmap',
  'devices',
  'page_views',
  'goals',
] as const;

export type DashboardWidgetKey = (typeof DASHBOARD_WIDGET_KEYS)[number];

const WIDGET_KEY_SET = new Set<string>(DASHBOARD_WIDGET_KEYS);

/** True if `value` is a known native dashboard widget key. */
export function isKnownDashboardWidget(value: unknown): boolean {
  return typeof value === 'string' && WIDGET_KEY_SET.has(value);
}

/**
 * Array-element decorator rejecting any unknown dashboard widget key. Apply with
 * `{ each: true }` on `order` / `hidden_widgets`. Lists the valid keys in the
 * error so the M2M caller gets an actionable 400 instead of a silent broken
 * layout.
 */
export function IsKnownDashboardWidget(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isKnownDashboardWidget',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isKnownDashboardWidget(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `each value in ${args.property} must be a known dashboard widget (one of: ${DASHBOARD_WIDGET_KEYS.join(', ')})`;
        },
      },
    });
  };
}
