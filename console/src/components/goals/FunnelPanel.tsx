import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Select, Empty, Skeleton, Segmented, Alert } from 'antd'
import { api } from '../../lib/api'
import {
  CHANNEL_GROUP_ORDER,
  channelGroupLabel,
} from '../../lib/channel-labels'
import {
  isFunnelSegmented,
  type DateRange,
  type FunnelResult,
} from '../../types/analytics'
import { FunnelSeriesChart } from './FunnelSeriesChart'

interface FunnelPanelProps {
  workspaceId: string
  dateRange: DateRange
  timezone: string
}

/** Dimensions sûres pour segmenter le tunnel (toutes présentes sur `goals`). */
const SEGMENT_OPTIONS = [
  { label: 'Ne pas segmenter', value: '__none__' },
  { label: 'Variante (A/B/C)', value: 'variant' },
  { label: 'Appareil', value: 'device' },
  { label: "Canal d'acquisition", value: 'channel_group' },
  { label: 'Pays', value: 'country' },
] as const

/** Palette d'accents pour distinguer les séries A/B/C… en mode comparaison. */
const SEGMENT_ACCENTS = [
  'var(--primary)',
  '#0ea5e9',
  '#f59e0b',
  '#10b981',
  '#ec4899',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#84cc16',
  '#e11d48',
]

/** Nombre d'étapes pré-remplies à l'ouverture (parmi les objectifs les + fréquents). */
const DEFAULT_STEP_COUNT = 4

/**
 * Entonnoir de conversion (tunnel de vente) NATIF de la page Objectifs.
 *
 * L'utilisateur choisit 2 à 8 objectifs ordonnés ; le panel affiche combien de
 * sessions/visiteurs franchissent chaque étape. Deux nouveautés VAGUE 2 :
 *  - **Comparaison A/B/C** : segmentez le tunnel par variante (ou appareil,
 *    canal, pays) → une colonne d'entonnoir par valeur, côte à côte, en UNE
 *    requête ClickHouse (`segment_by`).
 *  - **Valeur €** : basculez le tunnel sur la valeur générée par étape.
 *
 * Aucune sous-route custom : ce composant vit DANS la page Objectifs native
 * (vision 2026-05-23 : extensions dans l'UI de base, pas de page à part).
 */
export function FunnelPanel({ workspaceId, dateRange, timezone }: FunnelPanelProps) {
  const [steps, setSteps] = useState<string[]>([])
  const [channelGroup, setChannelGroup] = useState<string | undefined>(undefined)
  const [unit, setUnit] = useState<'session' | 'visitor'>('session')
  const [segmentBy, setSegmentBy] = useState<string | undefined>(undefined)
  const [metric, setMetric] = useState<'count' | 'value'>('count')

  // Discover available goal names (over the same period) to populate the picker.
  const { data: goalNamesResp } = useQuery({
    queryKey: ['funnel', 'goalNames', workspaceId, dateRange],
    queryFn: () =>
      api.analytics.query({
        workspace_id: workspaceId,
        table: 'goals',
        metrics: ['goals'],
        dimensions: ['goal_name'],
        dateRange,
        timezone,
        order: { goals: 'desc' },
        limit: 100,
      }),
    staleTime: 60_000,
  })

  const goalOptions = useMemo(() => {
    const rows = (goalNamesResp?.data as Record<string, unknown>[] | undefined) ?? []
    return rows
      .map((r) => String(r.goal_name ?? ''))
      .filter((g) => g.length > 0)
      .map((g) => ({ label: g, value: g }))
  }, [goalNamesResp])

  // Pré-remplissage : à l'ouverture, si aucune étape choisie et des objectifs
  // existent, on amorce le tunnel avec les N objectifs les plus fréquents (déjà
  // triés desc). Effet « waouh » immédiat, sans écraser une sélection utilisateur.
  useEffect(() => {
    if (steps.length === 0 && goalOptions.length >= 2) {
      setSteps(goalOptions.slice(0, DEFAULT_STEP_COUNT).map((o) => o.value))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalOptions])

  const channelOptions = useMemo(
    () => [
      { label: 'Tous les canaux', value: '__all__' },
      ...CHANNEL_GROUP_ORDER.map((g) => ({
        label: channelGroupLabel(g),
        value: g,
      })),
    ],
    [],
  )

  const {
    data: funnel,
    isLoading,
    error,
  } = useQuery<FunnelResult>({
    queryKey: [
      'funnel',
      'compute',
      workspaceId,
      dateRange,
      steps,
      channelGroup,
      unit,
      segmentBy,
    ],
    enabled: steps.length >= 2,
    queryFn: () =>
      api.analytics.funnel({
        workspace_id: workspaceId,
        steps: steps.map((g) => ({ goal_name: g })),
        dateRange,
        timezone,
        unit,
        ...(segmentBy ? { segment_by: segmentBy } : {}),
        ...(channelGroup
          ? {
              filters: [
                {
                  dimension: 'channel_group',
                  operator: 'equals',
                  values: [channelGroup],
                },
              ],
            }
          : {}),
      }),
    staleTime: 60_000,
    retry: false,
  })

  const segmentLabel =
    SEGMENT_OPTIONS.find((o) => o.value === segmentBy)?.label ?? segmentBy

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="flex flex-col gap-3 mb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Entonnoir de conversion</h2>
          <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
            Choisissez 2 à 8 objectifs dans l'ordre du parcours. Segmentez par
            variante pour comparer vos expériences A/B/C côte à côte.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="small"
            value={metric}
            onChange={(v) => setMetric(v as 'count' | 'value')}
            options={[
              { label: 'Volume', value: 'count' },
              { label: 'Valeur €', value: 'value' },
            ]}
          />
          <Segmented
            size="small"
            value={unit}
            onChange={(v) => setUnit(v as 'session' | 'visitor')}
            options={[
              { label: 'Sessions', value: 'session' },
              { label: 'Visiteurs', value: 'visitor' },
            ]}
          />
          <Select
            size="middle"
            style={{ minWidth: 180 }}
            value={segmentBy ?? '__none__'}
            onChange={(v) => setSegmentBy(v === '__none__' ? undefined : v)}
            options={SEGMENT_OPTIONS as unknown as { label: string; value: string }[]}
          />
          <Select
            size="middle"
            style={{ minWidth: 180 }}
            value={channelGroup ?? '__all__'}
            onChange={(v) => setChannelGroup(v === '__all__' ? undefined : v)}
            options={channelOptions}
          />
        </div>
      </div>

      <Select
        mode="multiple"
        allowClear
        placeholder="Sélectionnez les étapes du tunnel (dans l'ordre)…"
        style={{ width: '100%' }}
        value={steps}
        onChange={(v) => setSteps((v as string[]).slice(0, 8))}
        options={goalOptions}
        maxCount={8}
        className="mb-5"
        notFoundContent={
          goalOptions.length === 0 ? 'Aucun objectif sur la période' : undefined
        }
      />

      {steps.length < 2 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Sélectionnez au moins 2 objectifs pour construire l'entonnoir"
          className="py-10"
        />
      ) : error ? (
        <Alert
          type="warning"
          showIcon
          message="Impossible de calculer cet entonnoir"
          description={
            segmentBy
              ? `La segmentation par « ${segmentLabel} » a échoué (trop de valeurs distinctes, ou dimension indisponible sur cette période). Essayez sans segmentation.`
              : "Réessayez avec d'autres étapes ou une autre période."
          }
          className="my-6"
        />
      ) : isLoading || !funnel ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : isFunnelSegmented(funnel) ? (
        // ── Mode comparaison A/B/C : N colonnes côte à côte ──────────────
        funnel.segments.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`Aucune donnée segmentée par « ${segmentLabel} » sur cette séquence`}
            className="py-10"
          />
        ) : (
          <div>
            <div className="mb-3 text-sm text-[var(--muted-foreground)]">
              Comparaison par <strong>{segmentLabel}</strong> —{' '}
              {funnel.segments.length} série(s)
            </div>
            <div
              className="grid gap-5"
              style={{
                gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))`,
              }}
            >
              {funnel.segments.map((seg, i) => (
                <div
                  key={seg.key}
                  className="rounded-lg border border-[var(--border)] p-3"
                >
                  <FunnelSeriesChart
                    steps={seg.steps}
                    entered={seg.entered}
                    overallConversion={seg.overall_conversion}
                    title={
                      segmentBy === 'variant' ? `Variante ${seg.label}` : seg.label
                    }
                    accent={SEGMENT_ACCENTS[i % SEGMENT_ACCENTS.length]}
                    metric={metric}
                    compact
                  />
                  <div className="mt-2 text-center text-xs text-[var(--muted-foreground)]">
                    {seg.entered.toLocaleString('fr-FR')} entrées
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : funnel.entered === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Aucune conversion sur cette séquence pour la période et le canal choisis"
          className="py-10"
        />
      ) : (
        // ── Mode mono-série ──────────────────────────────────────────────
        <FunnelSeriesChart
          steps={funnel.steps}
          entered={funnel.entered}
          overallConversion={funnel.overall_conversion}
          metric={metric}
        />
      )}
    </div>
  )
}
