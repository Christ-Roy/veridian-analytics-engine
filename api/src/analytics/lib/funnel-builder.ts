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

  // levelN booleans → per-group max funnel level.
  const levelExprs = steps
    .map((_, i) => `countIf(level >= ${i + 1}) AS s${i}`)
    .join(',\n      ');

  // NOTE: we deliberately use an inline parenthesized subquery (NOT a `WITH …
  // AS` CTE). ClickHouseService.qualifyTableNames() rewrites every `FROM <word>`
  // into `FROM <db>.<word>` — it would wrongly qualify a CTE name
  // (`FROM per_group` → `FROM <db>.per_group` → "unknown table"). A `FROM (`
  // subquery is left untouched by that regex, so it is injection-/qualifier-safe.
  const sql = `
    SELECT
      ${levelExprs}
    FROM (
      SELECT
        ${groupCol} AS g,
        windowFunnel({window:UInt32})(
          toDateTime(goal_timestamp),
          ${stepConds.join(',\n          ')}
        ) AS level
      FROM goals
      WHERE goal_timestamp >= {start:DateTime64(3)}
        AND goal_timestamp <= {end:DateTime64(3)}
        ${unitGuard}
        ${filterSql ? `AND ${filterSql}` : ''}
      GROUP BY ${groupCol}
    )
  `;

  return { sql, params };
}
