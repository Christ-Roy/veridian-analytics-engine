import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '../utils';
import { METRIC_META, type MetricKey, type QueryRow } from './types';

/**
 * Table de résultats façon GSC : colonne dimension + 4 colonnes métriques,
 * triable par chaque colonne, avec filtre client (input texte).
 *
 * Port adapté du legacy `veridian-analytics/components/gsc/data-table.tsx` :
 * - pas de pagination (le bridge sert déjà top 50 server-side, suffisant
 *   pour la V1 commerciale)
 * - tri client (la dataset est petite, pas besoin de re-fetch)
 */
export function GscDataTable({
  rows,
  dimensionLabel,
}: {
  rows: QueryRow[];
  dimensionLabel: string;
}) {
  const [orderBy, setOrderBy] = useState<MetricKey>('clicks');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc');
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => {
    const filtered = query
      ? rows.filter((r) =>
          r.keys.some((k) => k.toLowerCase().includes(query.toLowerCase())),
        )
      : rows;
    const sortedArr = [...filtered].sort((a, b) => {
      const av = a[orderBy];
      const bv = b[orderBy];
      return orderDir === 'desc' ? bv - av : av - bv;
    });
    return sortedArr;
  }, [rows, query, orderBy, orderDir]);

  const onSort = (m: MetricKey) => {
    if (orderBy === m) {
      setOrderDir(orderDir === 'desc' ? 'asc' : 'desc');
    } else {
      setOrderBy(m);
      setOrderDir('desc');
    }
  };

  const sortIcon = (m: MetricKey) => {
    if (orderBy !== m) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return orderDir === 'desc' ? (
      <ArrowDown className="h-3 w-3" />
    ) : (
      <ArrowUp className="h-3 w-3" />
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border p-3">
        <input
          placeholder="Filtrer la vue…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 w-full max-w-sm rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {sorted.length} ligne{sorted.length > 1 ? 's' : ''}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/30">
            <tr>
              <th className="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {dimensionLabel}
              </th>
              {(['clicks', 'impressions', 'ctr', 'position'] as MetricKey[]).map(
                (m) => (
                  <th
                    key={m}
                    className="px-4 py-2 text-right"
                    style={{ minWidth: 110 }}
                  >
                    <button
                      type="button"
                      onClick={() => onSort(m)}
                      data-testid={`sort-${m}`}
                      className={cn(
                        'inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground',
                        orderBy === m && 'text-foreground',
                      )}
                    >
                      {METRIC_META[m].label}
                      {sortIcon(m)}
                    </button>
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                >
                  Pas de données.
                </td>
              </tr>
            ) : (
              sorted.map((r, i) => (
                <tr
                  key={i}
                  className="border-t border-border transition-colors hover:bg-muted/20"
                  data-testid={`gsc-row-${i}`}
                >
                  <td
                    className="max-w-md truncate px-4 py-2 text-foreground"
                    title={r.keys[0]}
                  >
                    {r.keys[0] || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {METRIC_META.clicks.format(r.clicks)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {METRIC_META.impressions.format(r.impressions)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {METRIC_META.ctr.format(r.ctr)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {METRIC_META.position.format(r.position)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
