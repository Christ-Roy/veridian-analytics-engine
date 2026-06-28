import { FilterDto } from '../dto/analytics-query.dto';
import { FunnelStepDto } from '../dto/funnel-query.dto';
import { buildFilters } from './filter-builder';

export interface FunnelQuerySpec {
  steps: FunnelStepDto[];
  start: string; // ClickHouse DateTime
  end: string; // ClickHouse DateTime
  unit: 'session' | 'visitor';
  windowSeconds: number;
  filters?: FilterDto[];
  /**
   * Segmentation A/B/C (A1). Quand fourni, le funnel est calculé une série par
   * valeur distincte de la dimension EN UNE SEULE requête : la colonne est
   * ajoutée au sous-select (au GROUP BY de l'unité) et au GROUP BY externe.
   * - `column` : expression SQL brute de la dimension (ex : `properties['variant']`,
   *   résolue par l'appelant via `DIMENSIONS[segment_by].column`).
   * - `name`   : nom de la dimension, utilisé comme alias de la colonne projetée
   *   (le résultat est keyé par ce nom, cf. pattern query-builder).
   * - `limit`  : garde-fou de cardinalité — le SQL ramène au plus `limit` lignes
   *   (l'appelant en demande `SEGMENT_MAX + 1` pour détecter le dépassement).
   */
  segment?: { column: string; name: string; limit: number };
}

export interface BuiltFunnelQuery {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Construit la requête ClickHouse `windowFunnel` du tunnel sur la table durable
 * `goals` (channel/channel_group y sont propagés par goals_mv, et la table n'a
 * pas le TTL 7j de `events`).
 *
 * Principe : par unité (session_id ou visitor_id), `windowFunnel(window)` rend
 * le plus long préfixe d'étapes consécutivement franchies (dans l'ordre, dans la
 * fenêtre temporelle). On compte ensuite combien d'unités atteignent ≥ niveau N
 * pour chaque étape. Injection-safe : conditions paramétrées, identifiants de
 * colonnes contrôlés.
 *
 * Détail levels : `arrayCount(x -> x >= i, range(1, n+1))`… non — on agrège côté
 * SQL avec un sumIf par niveau pour rester lisible et borné (≤ 8 étapes).
 */
export function buildFunnelQuery(spec: FunnelQuerySpec): BuiltFunnelQuery {
  const { steps, start, end, unit, windowSeconds } = spec;
  const groupCol = unit === 'visitor' ? 'visitor_id' : 'session_id';

  const params: Record<string, unknown> = {
    start,
    end,
    window: windowSeconds,
  };

  // One param per step goal name. windowFunnel conditions, IN ORDER.
  const stepConds = steps.map((s, i) => {
    const p = `step${i}`;
    params[p] = s.goal_name;
    return `goal_name = {${p}:String}`;
  });

  // Channel / dimension filters compiled against the goals table.
  const { sql: filterSql, params: filterParams } = buildFilters(
    spec.filters ?? [],
    'ff',
    'goals',
  );
  Object.assign(params, filterParams);

  // For the visitor unit we still need a non-empty visitor_id to be meaningful;
  // sessions with empty visitor_id collapse to a single bucket otherwise, so we
  // exclude them in that mode. In session mode session_id is always present.
  const unitGuard =
    unit === 'visitor' ? `AND visitor_id != ''` : `AND session_id != ''`;

  // Per-step aggregates over the per-group funnel level:
  //  - countIf(level >= N) AS sN  → units reaching step N
  //  - sumIf(value, level >= N) AS vN → € value at step N (A3-value). `value` is
  //    the per-unit total goal_value (sum over the unit's goals in window), so the
  //    outer sumIf adds each qualifying unit's value once (no double counting
  //    across the unit's individual goal rows).
  const levelExprs = steps
    .map(
      (_, i) =>
        `countIf(level >= ${i + 1}) AS s${i}, sumIf(value, level >= ${i + 1}) AS v${i}`,
    )
    .join(',\n      ');

  // Segmentation (A1): when a segment dimension is supplied we add it to BOTH
  // the inner per-unit GROUP BY (so each unit keeps its segment value) and the
  // outer aggregation (one row of sN/vN per segment value). The segment column
  // is projected under its dimension NAME alias when the expression differs
  // (Map accessors like `properties['variant']`), exactly like the query-builder
  // does, so the result row is keyed by the dimension name. A hard LIMIT guards
  // cardinality (caller asks SEGMENT_MAX+1 to detect overflow).
  const seg = spec.segment;
  // Inner projection line for the segment column (keyed `seg`), placed between
  // the per-unit `value` and the windowFunnel. It carries its OWN trailing comma
  // so it slots cleanly between the two without touching their commas.
  const segInnerSelect = seg ? `\n        ${seg.column} AS seg,` : '';
  const segInnerGroupBy = seg ? `, seg` : '';
  const segOuterSelect = seg ? `seg AS \`${seg.name}\`,\n      ` : '';
  const segOuterGroupBy = seg ? `\n    GROUP BY seg` : '';
  const segOuterOrderLimit = seg
    ? `\n    ORDER BY s0 DESC\n    LIMIT ${seg.limit}`
    : '';

  // NOTE: we deliberately use an inline parenthesized subquery (NOT a `WITH …
  // AS` CTE). ClickHouseService.qualifyTableNames() rewrites every `FROM <word>`
  // into `FROM <db>.<word>` — it would wrongly qualify a CTE name
  // (`FROM per_group` → `FROM <db>.per_group` → "unknown table"). A `FROM (`
  // subquery is left untouched by that regex, so it is injection-/qualifier-safe.
  const sql = `
    SELECT
      ${segOuterSelect}${levelExprs}
    FROM (
      SELECT
        ${groupCol} AS g,
        sum(goal_value) AS value,${segInnerSelect}
        windowFunnel({window:UInt32})(
          toDateTime(goal_timestamp),
          ${stepConds.join(',\n          ')}
        ) AS level
      FROM goals
      WHERE goal_timestamp >= {start:DateTime64(3)}
        AND goal_timestamp <= {end:DateTime64(3)}
        ${unitGuard}
        ${filterSql ? `AND ${filterSql}` : ''}
      GROUP BY ${groupCol}${segInnerGroupBy}
    )${segOuterGroupBy}${segOuterOrderLimit}
  `;

  return { sql, params };
}
