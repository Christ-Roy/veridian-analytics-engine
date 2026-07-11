import { useEffect, useState } from 'react'
import {
  Drawer,
  Button,
  List,
  Switch,
  Space,
  Empty,
  Divider,
  Typography,
  App,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { WidgetBuilder } from './WidgetBuilder'
import {
  DASHBOARD_WIDGET_KEYS,
  type DashboardWidgetKey,
} from '../dashboard-layout'
import { widgetMetricLabel, widgetDimensionLabel } from '../widget-catalog'
import type { DashboardWidget, DashboardLayout } from '../../../types/workspace'

const { Text } = Typography

/** Libellés FR des widgets natifs configurables. */
const NATIVE_LABELS: Record<DashboardWidgetKey, string> = {
  pages: 'Pages les plus consultées',
  sources: 'Sources principales',
  campaigns: 'Campagnes',
  countries: 'Pays',
  heatmap: 'Carte de fréquentation',
  devices: 'Appareils',
  page_views: 'Pages vues',
  goals: 'Objectifs',
}

const KIND_LABELS: Record<DashboardWidget['kind'], string> = {
  metric_card: 'Indicateur',
  time_series: 'Série',
  dimension_table: 'Tableau',
}

/** Résumé lisible d'un widget custom (métrique · dimension). */
function widgetSummary(w: DashboardWidget): string {
  const parts = [KIND_LABELS[w.kind], widgetMetricLabel(w.metric)]
  if (w.dimension) parts.push(`par ${widgetDimensionLabel(w.dimension)}`)
  return parts.join(' · ')
}

/**
 * Panneau de GESTION self-service du tableau de bord (VAGUE 2).
 *
 * L'utilisateur gère lui-même ses widgets : ajoute/édite/supprime des widgets
 * CUSTOM (via WidgetBuilder), les réordonne, et masque/affiche les widgets
 * natifs. Persistance via `workspaces.update({settings:{dashboard_layout}})`
 * (le backend MERGE les settings → branding/funnels/annotations préservés).
 * Aucune sous-route : ce drawer s'ouvre depuis un bouton du dashboard natif.
 */
export function DashboardManagerDrawer({
  open,
  onClose,
  workspaceId,
  layout,
}: {
  open: boolean
  onClose: () => void
  workspaceId: string
  layout?: DashboardLayout
}) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()

  const [widgets, setWidgets] = useState<DashboardWidget[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [builderOpen, setBuilderOpen] = useState(false)
  const [editing, setEditing] = useState<DashboardWidget | null>(null)

  // Copie locale éditable à chaque ouverture (repart de l'état persisté).
  useEffect(() => {
    if (!open) return
    setWidgets(layout?.widgets ? [...layout.widgets] : [])
    setHidden(new Set(layout?.hidden_widgets ?? []))
  }, [open, layout])

  const moveWidget = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= widgets.length) return
    const next = [...widgets]
    ;[next[i], next[j]] = [next[j], next[i]]
    setWidgets(next)
  }

  const removeWidget = (id: string) =>
    setWidgets((w) => w.filter((x) => x.id !== id))

  const upsertWidget = (widget: DashboardWidget) => {
    setWidgets((w) => {
      const idx = w.findIndex((x) => x.id === widget.id)
      if (idx === -1) return [...w, widget]
      const next = [...w]
      next[idx] = widget
      return next
    })
    setBuilderOpen(false)
    setEditing(null)
  }

  const toggleNative = (key: string, show: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (show) next.delete(key)
      else next.add(key)
      return next
    })

  const save = useMutation({
    mutationFn: () => {
      // order = ids custom dans l'ordre choisi (ils s'affichent en tête, les
      // natifs suivent dans leur ordre — cf. orderDashboardWidgets).
      const dashboard_layout: DashboardLayout = {
        widgets,
        hidden_widgets: Array.from(hidden),
        order: widgets.map((w) => w.id),
      }
      return api.workspaces.update({
        id: workspaceId,
        settings: { dashboard_layout },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] })
      message.success('Tableau de bord mis à jour')
      onClose()
    },
    onError: () => message.error("Échec de l'enregistrement du tableau de bord"),
  })

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title="Gérer le tableau de bord"
        width={480}
        extra={
          <Button
            type="primary"
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Enregistrer
          </Button>
        }
      >
        <div className="flex items-center justify-between mb-2">
          <Text strong>Mes widgets</Text>
          <Button
            type="dashed"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null)
              setBuilderOpen(true)
            }}
          >
            Ajouter un widget
          </Button>
        </div>

        {widgets.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Aucun widget personnalisé pour l'instant"
            className="py-6"
          />
        ) : (
          <List
            size="small"
            dataSource={widgets}
            rowKey={(w) => w.id}
            renderItem={(w, i) => (
              <List.Item
                actions={[
                  <Button
                    key="up"
                    type="text"
                    size="small"
                    icon={<ArrowUpOutlined />}
                    disabled={i === 0}
                    onClick={() => moveWidget(i, -1)}
                    aria-label="Monter"
                  />,
                  <Button
                    key="down"
                    type="text"
                    size="small"
                    icon={<ArrowDownOutlined />}
                    disabled={i === widgets.length - 1}
                    onClick={() => moveWidget(i, 1)}
                    aria-label="Descendre"
                  />,
                  <Button
                    key="edit"
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditing(w)
                      setBuilderOpen(true)
                    }}
                    aria-label="Modifier"
                  />,
                  <Button
                    key="del"
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeWidget(w.id)}
                    aria-label="Supprimer"
                  />,
                ]}
              >
                <List.Item.Meta
                  title={w.title}
                  description={<Text type="secondary">{widgetSummary(w)}</Text>}
                />
              </List.Item>
            )}
          />
        )}

        <Divider />

        <Text strong>Widgets natifs</Text>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5 mb-2">
          Affichez ou masquez les widgets standards du tableau de bord.
        </p>
        <List
          size="small"
          dataSource={[...DASHBOARD_WIDGET_KEYS]}
          rowKey={(k) => k}
          renderItem={(key) => (
            <List.Item
              actions={[
                <Switch
                  key="show"
                  size="small"
                  checked={!hidden.has(key)}
                  onChange={(show) => toggleNative(key, show)}
                />,
              ]}
            >
              <Space>{NATIVE_LABELS[key]}</Space>
            </List.Item>
          )}
        />
      </Drawer>

      <WidgetBuilder
        open={builderOpen}
        initial={editing}
        onSave={upsertWidget}
        onCancel={() => {
          setBuilderOpen(false)
          setEditing(null)
        }}
      />
    </>
  )
}
