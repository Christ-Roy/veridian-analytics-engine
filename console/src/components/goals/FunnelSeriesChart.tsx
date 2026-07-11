import { Tooltip } from 'antd'
import type { FunnelStepResult } from '../../types/analytics'

/**
 * Rendu premium d'UNE série d'entonnoir (trapèze centré). Réutilisable :
 * - mode mono → une seule série pleine largeur
 * - mode A/B/C → N `FunnelSeriesChart` côte à côte (une par variante)
 *
 * Chaque étape est un trapèze qui rétrécit proportionnellement au `count` (ou à
 * la valeur € en mode valeur), avec le taux de passage N→N+1 et les abandons
 * mis en valeur entre deux étapes. Aucune dépendance graphique lourde (pas
 * d'echarts ici) : SVG/flex + tokens de la charte → léger, responsive, testable.
 */

export interface FunnelSeriesChartProps {
  /** Étapes du tunnel (déjà ordonnées étape 1 → N). */
  steps: FunnelStepResult[]
  /** Unités entrées (= count étape 1). */
  entered: number
  /** Conversion bout-en-bout (%). */
  overallConversion: number
  /** Titre de la série (ex : « Variante A »). Absent en mode mono. */
  title?: string
  /** Couleur d'accent de la série (défaut = --primary). Distingue les variantes. */
  accent?: string
  /** Base de largeur : `count` (défaut) ou `value` (€ généré). */
  metric?: 'count' | 'value'
  /** Compact = colonnes A/B/C serrées (police réduite). */
  compact?: boolean
}

/** Couleur d'un taux de passage : vert (bon) → ambre → rouge (fuite). */
function conversionColor(pct: number | null): string {
  if (pct === null) return 'var(--muted-foreground)'
  if (pct >= 50) return 'var(--success, #16a34a)'
  if (pct >= 20) return '#d97706'
  return '#ef4444'
}

function fmt(n: number): string {
  return n.toLocaleString('fr-FR')
}

export function FunnelSeriesChart({
  steps,
  entered,
  overallConversion,
  title,
  accent = 'var(--primary)',
  metric = 'count',
  compact = false,
}: FunnelSeriesChartProps) {
  const base = (s: FunnelStepResult) => (metric === 'value' ? s.value : s.count)
  const maxBase = steps.reduce((m, s) => Math.max(m, base(s)), 0)

  return (
    <div className="flex flex-col">
      {title && (
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span
            className="font-semibold truncate"
            style={{ color: accent, fontSize: compact ? 13 : 15 }}
          >
            {title}
          </span>
          <Tooltip title="Conversion bout-en-bout (étape 1 → dernière étape)">
            <span
              className="font-semibold whitespace-nowrap"
              style={{ color: accent, fontSize: compact ? 13 : 15 }}
            >
              {fmt(overallConversion)} %
            </span>
          </Tooltip>
        </div>
      )}

      <div className={compact ? 'text-[11px]' : 'text-sm'}>
        {steps.map((s, i) => {
          const widthPct = maxBase > 0 ? Math.max(6, (base(s) / maxBase) * 100) : 0
          const isFirst = i === 0
          return (
            <div key={s.step}>
              {/* Zone d'abandon entre l'étape précédente et celle-ci. */}
              {!isFirst && s.conversion_from_previous !== null && (
                <div
                  className="flex items-center justify-center gap-1 py-0.5"
                  style={{ color: conversionColor(s.conversion_from_previous) }}
                >
                  <span aria-hidden>↓</span>
                  <span className="font-medium">
                    {fmt(s.conversion_from_previous)} %
                  </span>
                  {s.dropoff_from_previous > 0 && (
                    <span className="text-[var(--muted-foreground)]">
                      ({fmt(s.dropoff_from_previous)} abandons)
                    </span>
                  )}
                </div>
              )}

              {/* Le trapèze de l'étape (barre centrée qui rétrécit). */}
              <Tooltip
                title={
                  <span>
                    <strong>{s.label}</strong>
                    <br />
                    {fmt(s.count)} {metric === 'count' ? '' : ''}
                    {metric === 'value' && <> · {fmt(s.value)} €</>}
                    <br />
                    {fmt(s.conversion_from_start)} % depuis le départ
                  </span>
                }
              >
                <div className="flex justify-center">
                  <div
                    className="rounded-md flex flex-col items-center justify-center text-white transition-all"
                    style={{
                      width: `${widthPct}%`,
                      minWidth: compact ? 44 : 64,
                      background: accent,
                      padding: compact ? '6px 4px' : '10px 8px',
                      opacity: 0.55 + 0.45 * (widthPct / 100),
                    }}
                  >
                    <span
                      className="font-semibold leading-none"
                      style={{ fontSize: compact ? 13 : 16 }}
                    >
                      {fmt(base(s))}
                      {metric === 'value' && ' €'}
                    </span>
                    <span
                      className="leading-tight text-center opacity-90 mt-0.5"
                      style={{ fontSize: compact ? 10 : 12 }}
                    >
                      {s.label}
                    </span>
                  </div>
                </div>
              </Tooltip>
            </div>
          )
        })}
      </div>

      {!title && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-[var(--muted-foreground)]">
            Entrées : <strong>{fmt(entered)}</strong>
          </span>
          <span className="text-[var(--muted-foreground)]">
            Conversion globale :{' '}
            <strong style={{ color: accent }}>{fmt(overallConversion)} %</strong>
          </span>
        </div>
      )}
    </div>
  )
}
