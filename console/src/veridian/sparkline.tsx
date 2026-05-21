import { cn } from './utils';

/**
 * Sparkline SVG minimaliste, zero dep.
 * Dessine une ligne lissée (cubic bezier simplifié) avec zone de remplissage
 * dégradée et un point au dernier data point.
 *
 * Port direct de `veridian-analytics/components/sparkline.tsx`.
 */
export function Sparkline({
  data,
  className,
  positive = true,
  height = 40,
  width = 160,
  strokeWidth = 1.5,
}: {
  data: Array<{ day: string; value: number }>;
  className?: string;
  positive?: boolean;
  height?: number;
  width?: number;
  strokeWidth?: number;
}) {
  if (!data || data.length === 0) {
    return <div className={cn('h-10', className)} data-testid="sparkline-empty" />;
  }

  const values = data.map((d) => d.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const stepX = width / Math.max(data.length - 1, 1);

  const points = data.map((d, i) => ({
    x: i * stepX,
    y: height - 2 - ((d.value - min) / range) * (height - 4),
  }));

  const linePath = points
    .map((p, i, arr) => {
      if (i === 0) return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      const prev = arr[i - 1];
      const cx1 = prev.x + (p.x - prev.x) / 2;
      const cy1 = prev.y;
      const cx2 = prev.x + (p.x - prev.x) / 2;
      const cy2 = p.y;
      return `C ${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(' ');

  const fillPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  const stroke = positive ? '#34d399' : '#fb7185'; // emerald-400 / rose-400
  const fillId = `spark-fill-${positive ? 'up' : 'down'}`;

  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-10 w-full', className)}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="sparkline-svg"
    >
      <defs>
        <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${fillId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x} cy={last.y} r={2.5} fill={stroke} />
    </svg>
  );
}
