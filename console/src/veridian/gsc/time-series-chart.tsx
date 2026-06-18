import { useMemo, useState } from 'react';
import { METRIC_META, type MetricKey } from './types';

type Series = Array<{ day: string; value: number }>;

/**
 * Graphique temporel multi-courbes façon Google Search Console.
 * Chaque metric active (clicks/impressions/ctr/position) a son propre axe
 * normalisé sur sa propre plage pour que toutes les courbes tiennent dans
 * le même canvas. Hover → tooltip avec les valeurs de chaque série sur ce jour.
 *
 * Rendu SVG maison (zéro dépendance de charting) recoloré sur la palette claire
 * de la console : grille et axes en gris neutre, crosshair sur la primaire
 * violet `#7763F1`, tooltip blanc AntD-like. Les courbes gardent les couleurs
 * sémantiques des métriques (`METRIC_META`).
 */
export function TimeSeriesChart({
  series,
  activeMetrics,
  height = 260,
}: {
  series: Record<MetricKey, Series>;
  activeMetrics: Record<MetricKey, boolean>;
  height?: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const dayLabels = useMemo(() => {
    const any = Object.values(series).find((s) => s.length > 0) || [];
    return any.map((p) => p.day);
  }, [series]);

  if (dayLabels.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-gray-200 bg-white text-sm text-gray-500"
        style={{ height }}
      >
        Pas de données pour cette période
      </div>
    );
  }

  const width = 1000; // viewBox width — s'étire via CSS
  const padLeft = 40;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 40;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const stepX = innerW / Math.max(dayLabels.length - 1, 1);

  // Normalise chaque série sur son propre min/max
  const normalized: Record<
    MetricKey,
    { points: Array<{ x: number; y: number; v: number }>; min: number; max: number }
  > = {} as never;

  (Object.keys(series) as MetricKey[]).forEach((k) => {
    const s = series[k];
    if (!s || s.length === 0) {
      normalized[k] = { points: [], min: 0, max: 0 };
      return;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const p of s) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    if (min === Infinity) min = 0;
    if (max === -Infinity) max = 0;
    // Pour la position, inversée (plus bas = meilleur)
    const isInverted = k === 'position';
    const range = max - min || 1;
    const points = s.map((p, i) => {
      const ratio = (p.value - min) / range;
      const y = padTop + (isInverted ? ratio : 1 - ratio) * innerH;
      return { x: padLeft + i * stepX, y, v: p.value };
    });
    normalized[k] = { points, min, max };
  });

  // Determine ticks X — max 8 labels pour ne pas surcharger
  const tickEvery = Math.max(1, Math.ceil(dayLabels.length / 8));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          style={{ height: `${height}px` }}
          preserveAspectRatio="none"
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x =
              ((e.clientX - rect.left) / rect.width) * width - padLeft;
            const i = Math.round(x / stepX);
            if (i >= 0 && i < dayLabels.length) setHoverIdx(i);
          }}
        >
          {/* Grid horizontal */}
          {[0, 0.25, 0.5, 0.75, 1].map((r) => (
            <line
              key={r}
              x1={padLeft}
              x2={width - padRight}
              y1={padTop + r * innerH}
              y2={padTop + r * innerH}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
          ))}

          {/* Tick labels X */}
          {dayLabels.map((d, i) =>
            i % tickEvery === 0 ? (
              <text
                key={d + i}
                x={padLeft + i * stepX}
                y={height - padBottom + 16}
                textAnchor="middle"
                fill="#9ca3af"
                fontSize="10"
              >
                {d.slice(5)}
              </text>
            ) : null,
          )}

          {/* Courbes */}
          {(Object.keys(normalized) as MetricKey[])
            .filter((k) => activeMetrics[k] && normalized[k].points.length > 1)
            .map((k) => {
              const pts = normalized[k].points;
              const path = pts
                .map((p, i) => {
                  if (i === 0) return `M ${p.x} ${p.y}`;
                  const prev = pts[i - 1];
                  const cx1 = prev.x + (p.x - prev.x) / 2;
                  const cy1 = prev.y;
                  const cx2 = prev.x + (p.x - prev.x) / 2;
                  const cy2 = p.y;
                  return `C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p.x} ${p.y}`;
                })
                .join(' ');
              return (
                <path
                  key={k}
                  d={path}
                  fill="none"
                  stroke={METRIC_META[k].color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}

          {/* Hover crosshair */}
          {hoverIdx !== null && (
            <>
              <line
                x1={padLeft + hoverIdx * stepX}
                x2={padLeft + hoverIdx * stepX}
                y1={padTop}
                y2={height - padBottom}
                stroke="#7763F1"
                strokeOpacity={0.4}
                strokeDasharray="2 2"
              />
              {(Object.keys(normalized) as MetricKey[])
                .filter(
                  (k) => activeMetrics[k] && normalized[k].points[hoverIdx],
                )
                .map((k) => (
                  <circle
                    key={k}
                    cx={normalized[k].points[hoverIdx].x}
                    cy={normalized[k].points[hoverIdx].y}
                    r={4}
                    fill={METRIC_META[k].color}
                    stroke="white"
                    strokeWidth={1.5}
                  />
                ))}
            </>
          )}
        </svg>

        {/* Tooltip */}
        {hoverIdx !== null && (
          <div
            className="pointer-events-none absolute rounded-md border border-gray-200 bg-white p-2 text-xs shadow-lg"
            style={{
              left: `${((padLeft + hoverIdx * stepX) / width) * 100}%`,
              top: 4,
              transform: 'translateX(-50%)',
              minWidth: 150,
            }}
          >
            <div className="mb-1 font-medium text-gray-900">
              {dayLabels[hoverIdx]}
            </div>
            {(Object.keys(normalized) as MetricKey[])
              .filter(
                (k) => activeMetrics[k] && normalized[k].points[hoverIdx],
              )
              .map((k) => {
                const v = normalized[k].points[hoverIdx].v;
                return (
                  <div
                    key={k}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: METRIC_META[k].color }}
                      />
                      {METRIC_META[k].label}
                    </span>
                    <span className="font-medium tabular-nums">
                      {METRIC_META[k].format(v)}
                    </span>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
