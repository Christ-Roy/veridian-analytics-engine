import { Card } from 'antd';
import { METRIC_META, type MetricKey } from './types';

/**
 * Tuile KPI façon GSC Performance : grand chiffre + couleur de la métrique.
 * Cliquable pour activer/désactiver la courbe correspondante sur le graphique.
 *
 * Rendu AntD natif (fond clair, accent primaire violet `#7763F1` quand la
 * tuile est active). La pastille colorée garde la couleur sémantique de la
 * métrique (bleu/violet/emerald/amber) pour rester lisible sur le graphique.
 */
export function KpiTile({
  metric,
  value,
  active,
  onToggle,
}: {
  metric: MetricKey;
  value: number;
  active: boolean;
  onToggle: () => void;
}) {
  const meta = METRIC_META[metric];
  return (
    <Card
      size="small"
      hoverable
      onClick={onToggle}
      data-testid={`kpi-${metric}`}
      data-active={active}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      styles={{ body: { padding: 16 } }}
      style={{
        cursor: 'pointer',
        minHeight: 88,
        borderColor: active ? '#7763F1' : undefined,
        boxShadow: active ? '0 0 0 1px #7763F1' : undefined,
        opacity: active ? 1 : 0.7,
        transition: 'all 0.15s ease',
      }}
    >
      <div className="flex flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: meta.color }}
          />
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-gray-500">
            {meta.label}
          </span>
        </div>
        <div
          className="text-3xl font-semibold tabular-nums"
          style={{ color: active ? meta.color : '#171717' }}
        >
          {meta.format(value)}
        </div>
      </div>
    </Card>
  );
}
