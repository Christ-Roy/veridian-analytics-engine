/**
 * Return a shallow copy of `obj` with every own key whose value is strictly
 * `undefined` removed.
 *
 * Why this exists (silent data-loss fix, ticket
 * 2026-06-24-setfeatures-replace-au-lieu-de-deep-merge):
 *
 * `class-transformer` (v0.5.x, used by Nest's global `ValidationPipe({
 * transform: true })`) materialises EVERY declared property of a DTO class on
 * the produced instance, defaulting unspecified optional fields to `undefined`
 * (its `exposeUnsetFields` option defaults to `true`). So a request body of
 * `{ features: { voip: true } }` becomes a `FeaturesDto` instance with three
 * OWN enumerable keys: `{ voip: true, gsc: undefined, connectors: undefined }`.
 *
 * A naive deep-merge `{ ...existing, ...dtoInstance }` then lets those
 * `undefined` values OVERWRITE previously-persisted flags — and because
 * `JSON.stringify` drops `undefined`, the loss is silent: persisting
 * `{ voip: true }` alone instead of `{ voip: true, gsc: <prev>, connectors:
 * <prev> }`. Confirmed in real staging: setting one feature flag wiped the
 * others.
 *
 * Stripping `undefined` BEFORE the merge makes "only the keys the caller
 * actually sent" the unit of change — a partial update never clobbers a field
 * it didn't mention. Booleans `false`/`0`/`''`/`null` are preserved (they are
 * meaningful, deliberate values); only `undefined` (= "not provided") is dropped.
 */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
