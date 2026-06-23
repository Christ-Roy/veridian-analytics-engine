/**
 * Single source of truth for IANA timezone validation.
 *
 * SECURITY (OWASP A03 — SQL injection): the `timezone` value flows from the
 * analytics query DTO straight into ClickHouse SQL string literals in the
 * query-builder (`toDate(col, '${tz}')`, etc.). It is NOT a bound parameter —
 * ClickHouse does not let you bind a timezone name in `toDate(col, tz)`.
 * Therefore the ONLY safe barrier is a strict whitelist: the value must be a
 * real IANA timezone identifier before it can ever touch the SQL string.
 *
 * We use the native `Intl` API (Node 18+, no dependency) as the authority:
 *  - `new Intl.DateTimeFormat(undefined, { timeZone: tz })` throws RangeError
 *    for anything that is not a valid IANA identifier. Any injection attempt
 *    ("UTC') OR 1=1 -- ", "Foo/Bar", "; DROP TABLE", quotes, semicolons,
 *    whitespace, comments) makes it throw → rejected.
 *  - It accepts canonical zones ("Europe/Paris"), legacy aliases ("UTC",
 *    "GMT") that `Intl.supportedValuesOf('timeZone')` omits, and is therefore
 *    the correct authority. (`supportedValuesOf` would wrongly reject "UTC".)
 *
 * Note: `Intl.DateTimeFormat` is case-insensitive on the identifier, so
 * "utc"/"europe/paris" are also accepted — these remain valid IANA identifiers
 * and contain no SQL metacharacters, so they are safe to interpolate.
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    // Throws RangeError if `tz` is not a recognized IANA timezone identifier.
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Defense-in-depth guard for code paths that interpolate a timezone into SQL.
 * Throws if `tz` is not a valid IANA identifier so that even an internal or
 * corrupted value (e.g. a malformed `workspace.timezone` read from DB) can
 * never reach the SQL string. Call this BEFORE any interpolation.
 */
export function assertValidTimezone(tz: string): void {
  if (!isValidTimezone(tz)) {
    throw new Error(`Invalid IANA timezone: ${JSON.stringify(tz)}`);
  }
}
