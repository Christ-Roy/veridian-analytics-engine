import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Select, Empty, Skeleton, Tooltip, Segmented } from 'antd'
import { api } from '../../lib/api'
import {
  CHANNEL_GROUP_ORDER,
  channelGroupLabel,
} from '../../lib/channel-labels'
import type { DateRange, FunnelResponse } from '../../types/analytics'

interface FunnelPanelProps {
  workspaceId: string
  dateRange: DateRange
  timezone: string
}

/**
 * Entonnoir de conversion (tunnel de vente) NATIF de la page Objectifs.
 *
 * L'utilisateur choisit 2 à 8 objectifs ordonnés ; le panel affiche combien de
 * sessions/visiteurs franchissent chaque étape, le taux N→N+1 et le taux global.
 * Filtrable par GROUPE DE CANAL (ads/seo/social/email/referral/direct) — c'est
 * le différenciateur "d'où viennent mes clients" appliqué au tunnel.
 *
 * Aucune sous-route custom : ce composant vit DANS la page Objectifs native
 * (vision 2026-05-23 : extensions dans l'UI de base, pas de page à part).
 */
export function FunnelPanel({ workspaceId, dateRange, timezone }: FunnelPanelProps) {
  const [steps, setSteps] = useState<string[]>([])
  const [channelGroup, setChannelGroup] = useState<string | undefined>(undefined)
  const [unit, setUnit] = useState<'session' | 'visitor'>('session')

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

  // Run the funnel only when ≥ 2 steps are selected.
  const { data: funnel, isLoading } = useQuery<FunnelResponse>({
    queryKey: ['funnel', 'compute', workspaceId, dateRange, steps, channelGroup, unit],
    enabled: steps.length >= 2,
    queryFn: () =>
      api.analytics.funnel({
        workspace_id: workspaceId,
        steps: steps.map((g) => ({ goal_name: g })),
        dateRange,
        timezone,
        unit,
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
  })

  const maxCount = useMemo(() => {
    if (!funnel) return 0
    return funnel.steps.reduce((m, s) => Math.max(m, s.count), 0)
  }, [funnel])

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="flex flex-col gap-3 mb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Entonnoir de conversion</h2>
          <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
            Choisissez 2 à 8 objectifs dans l'ordre du parcours. Filtrez par canal
            d'acquisition pour voir d'où viennent vos conversions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            style={{ minWidth: 200 }}
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
      ) : isLoading || !funnel ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : funnel.entered === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Aucune conversion sur cette séquence pour la période et le canal choisis"
          className="py-10"
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--muted-foreground)]">
              {unit === 'visitor' ? 'Visiteurs entrés' : 'Sessions entrées'} :{' '}
              <strong>{funnel.entered.toLocaleString('fr-FR')}</strong>
            </span>
            <span className="text-[var(--muted-foreground)]">
              Conversion globale :{' '}
              <strong className="text-[var(--primary)]">
                {funnel.overall_conversion.toLocaleString('fr-FR')} %
              </strong>
            </span>
          </div>

          {funnel.steps.map((s) => {
            const widthPct = maxCount > 0 ? Math.max(2, (s.count / maxCount) * 100) : 0
            return (
              <div key={s.step} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    <span className="text-[var(--muted-foreground)] mr-2">
                      {s.step}.
                    </span>
                    {s.label}
                  </span>
                  <span className="flex items-center gap-3">
                    <span>{s.count.toLocaleString('fr-FR')}</span>
                    {s.conversion_from_previous !== null && (
                      <Tooltip
                        title={`${s.dropoff_from_previous.toLocaleString('fr-FR')} abandons depuis l'étape précédente`}
                      >
                        <span
                          className={
                            s.conversion_from_previous >= 50
                              ? 'text-green-600'
                              : s.conversion_from_previous >= 20
                                ? 'text-amber-600'
                                : 'text-red-500'
                          }
                        >
                          {s.conversion_from_previous.toLocaleString('fr-FR')} %
                        </span>
                      </Tooltip>
                    )}
                  </span>
                </div>
                <div className="h-7 w-full rounded bg-[var(--muted)] overflow-hidden">
                  <div
                    className="h-full rounded bg-[var(--primary)] transition-all flex items-center justify-end pr-2"
                    style={{ width: `${widthPct}%` }}
                  >
                    <span className="text-xs text-white whitespace-nowrap">
                      {s.conversion_from_start.toLocaleString('fr-FR')} %
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
