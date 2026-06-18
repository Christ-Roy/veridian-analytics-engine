import { useMemo, useState, type HTMLAttributes } from 'react';
import { Input, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { METRIC_META, type MetricKey, type QueryRow } from './types';

/**
 * Table de résultats façon GSC : colonne dimension + 4 colonnes métriques,
 * triable par chaque colonne, avec filtre client (champ texte).
 *
 * Rendu AntD natif (`<Table>` + `<Input>`), fond clair, cohérent avec le reste
 * de la console. Le bridge sert déjà le top 50 server-side ; tri et filtre
 * restent côté client (dataset petit, pas de re-fetch).
 */
export function GscDataTable({
  rows,
  dimensionLabel,
}: {
  rows: QueryRow[];
  dimensionLabel: string;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const base = query
      ? rows.filter((r) =>
          r.keys.some((k) => k.toLowerCase().includes(query.toLowerCase())),
        )
      : rows;
    // index stable pour les data-testid de ligne (parité avec l'ancien rendu)
    return base.map((row, index) => ({ ...row, key: index }));
  }, [rows, query]);

  const metricColumn = (m: MetricKey): ColumnsType<QueryRow>[number] => ({
    title: METRIC_META[m].label,
    dataIndex: m,
    key: m,
    align: 'right',
    width: 120,
    sorter: (a, b) => a[m] - b[m],
    defaultSortOrder: m === 'clicks' ? 'descend' : undefined,
    render: (value: number) => (
      <span className="tabular-nums">{METRIC_META[m].format(value)}</span>
    ),
  });

  const columns: ColumnsType<QueryRow & { key: number }> = [
    {
      title: dimensionLabel,
      dataIndex: 'keys',
      key: 'dimension',
      ellipsis: true,
      render: (keys: string[]) =>
        keys[0] ? (
          <span title={keys[0]}>{keys[0]}</span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    metricColumn('clicks') as ColumnsType<QueryRow & { key: number }>[number],
    metricColumn('impressions') as ColumnsType<
      QueryRow & { key: number }
    >[number],
    metricColumn('ctr') as ColumnsType<QueryRow & { key: number }>[number],
    metricColumn('position') as ColumnsType<
      QueryRow & { key: number }
    >[number],
  ];

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 p-3">
        <Input
          placeholder="Filtrer la vue…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
          size="small"
          className="max-w-sm"
          data-testid="gsc-table-filter"
        />
        <Typography.Text type="secondary" className="whitespace-nowrap text-xs">
          {filtered.length} ligne{filtered.length > 1 ? 's' : ''}
        </Typography.Text>
      </div>
      <Table<QueryRow & { key: number }>
        columns={columns}
        dataSource={filtered}
        pagination={false}
        size="small"
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: 'Pas de données.' }}
        onRow={(_, index) =>
          ({ 'data-testid': `gsc-row-${index}` }) as HTMLAttributes<HTMLElement>
        }
      />
    </div>
  );
}
