/**
 * Single source of truth for SQL ORDER BY direction validation.
 *
 * SECURITY (OWASP A03 — SQL injection): the analytics query `order` field is
 * typed `Record<string, 'asc' | 'desc'>`, but TS types are NOT enforced at
 * runtime. The query-builder interpolates the direction raw into the SQL
 * `ORDER BY` clause (`${field} ${dir}`). The order *field* is whitelisted
 * against METRICS/DIMENSIONS, but the *direction* must be normalized to one of
 * exactly two literal keywords — never interpolated from user input — otherwise
 * `{ "sessions": "ASC, (SELECT ...)" }` injects arbitrary SQL after a valid
 * field.
 */
export type OrderDirection = 'asc' | 'desc';

const DIRECTION_SQL: Record<string, 'ASC' | 'DESC'> = {
  asc: 'ASC',
  desc: 'DESC',
};

/** True iff `dir` is a valid order direction (case-insensitive: asc/desc). */
export function isValidOrderDirection(dir: unknown): dir is OrderDirection {
  return typeof dir === 'string' && dir.toLowerCase() in DIRECTION_SQL;
}

/**
 * Defense-in-depth guard for the query-builder: maps a direction to its SQL
 * keyword via a fixed lookup (never via `.toUpperCase()` on user input) and
 * throws on anything that is not exactly asc/desc. Guarantees the value placed
 * in the SQL string is one of the two safe literals.
 */
export function normalizeOrderDirection(dir: unknown): 'ASC' | 'DESC' {
  if (typeof dir === 'string') {
    const sql = DIRECTION_SQL[dir.toLowerCase()];
    if (sql) return sql;
  }
  throw new Error(`Invalid order direction: ${JSON.stringify(dir)}`);
}
