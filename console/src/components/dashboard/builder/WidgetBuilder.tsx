import { useEffect, useMemo, useState } from 'react'
import { Modal, Input, Segmented, Select, InputNumber, Form, Alert } from 'antd'
import { MetricPicker, DimensionPicker, GranularityPicker, FilterEditor } from './field-pickers'
import type { DashboardWidget } from '../../../types/workspace'
import type { Filter, Granularity } from '../../../types/analytics'
import { WIDGET_SAFE_METRICS } from '../widget-catalog'

/**
 * Éditeur MODULAIRE d'un widget custom (VAGUE 2 — self-service).
 *
 * Produit/édite un `DashboardWidget` = description group-by
 * `{kind, table, metric, dimension?, granularity?, filters?, limit?}` résolue
 * par le query-builder générique (custom-widget.ts). L'utilisateur choisit
 * lui-même ses champs parmi la whitelist widget-safe (pickers réutilisables).
 *
 * Contrôlé par le parent : `open`, `initial` (widget édité ou null = création),
 * `onSave(widget)`, `onCancel`. Aucune persistance ici — le parent écrit via
 * `workspaces.update({settings:{dashboard_layout}})`.
 */

const KIND_OPTIONS = [
  { label: 'Indicateur', value: 'metric_card' },
  { label: 'Série temporelle', value: 'time_series' },
  { label: 'Tableau', value: 'dimension_table' },
] as const

const TABLE_OPTIONS = [
  { label: 'Sessions', value: 'sessions' },
  { label: 'Pages', value: 'pages' },
  { label: 'Objectifs', value: 'goals' },
] as const

type Kind = DashboardWidget['kind']
type Table = NonNullable<DashboardWidget['table']>

function slugId(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // retire les diacritiques combinants
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40)
  // Suffixe court unique (widget custom = id arbitraire de workspace).
  const rnd = Math.floor(Math.random() * 1e6).toString(36)
  return `${base || 'widget'}-${rnd}`
}

export function WidgetBuilder({
  open,
  initial,
  onSave,
  onCancel,
}: {
  open: boolean
  initial: DashboardWidget | null
  onSave: (widget: DashboardWidget) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<Kind>('metric_card')
  const [table, setTable] = useState<Table>('sessions')
  const [metric, setMetric] = useState<string>(WIDGET_SAFE_METRICS[0] ?? '')
  const [dimension, setDimension] = useState<string | undefined>(undefined)
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [filters, setFilters] = useState<Filter[]>([])
  const [limit, setLimit] = useState<number>(10)

  // (Re)initialise le formulaire à chaque ouverture / changement de cible.
  useEffect(() => {
    if (!open) return
    setTitle(initial?.title ?? '')
    setKind(initial?.kind ?? 'metric_card')
    setTable(initial?.table ?? 'sessions')
    setMetric(initial?.metric ?? WIDGET_SAFE_METRICS[0] ?? '')
    setDimension(initial?.dimension)
    setGranularity((initial?.granularity as Granularity) ?? 'day')
    setFilters(
      (initial?.filters ?? []).map((f) => ({
        dimension: f.dimension,
        operator: f.operator as Filter['operator'],
        values: f.values,
      })),
    )
    setLimit(initial?.limit ?? 10)
  }, [open, initial])

  const isDimensionTable = kind === 'dimension_table'
  const isTimeSeries = kind === 'time_series'

  // Validation : un tableau exige une dimension ; une série exige une granularité.
  const validationError = useMemo(() => {
    if (!title.trim()) return 'Donnez un titre au widget.'
    if (!metric) return 'Choisissez une métrique.'
    if (isDimensionTable && !dimension)
      return 'Un tableau doit être groupé par une dimension.'
    if (isTimeSeries && !granularity)
      return 'Une série temporelle doit avoir une granularité.'
    return null
  }, [title, metric, isDimensionTable, dimension, isTimeSeries, granularity])

  const handleSave = () => {
    if (validationError) return
    const widget: DashboardWidget = {
      id: initial?.id ?? slugId(title),
      kind,
      title: title.trim(),
      metric,
      table,
      ...(dimension ? { dimension } : {}),
      ...(isTimeSeries ? { granularity } : {}),
      ...(filters.length > 0
        ? {
            filters: filters
              .filter((f) => f.dimension)
              .map((f) => ({
                dimension: f.dimension,
                operator: f.operator,
                values: f.values,
              })),
          }
        : {}),
      ...(isDimensionTable ? { limit } : {}),
    }
    onSave(widget)
  }

  return (
    <Modal
      open={open}
      title={initial ? 'Modifier le widget' : 'Ajouter un widget'}
      onOk={handleSave}
      onCancel={onCancel}
      okText="Enregistrer"
      cancelText="Annuler"
      okButtonProps={{ disabled: !!validationError }}
      width={640}
      destroyOnClose
    >
      <Form layout="vertical" className="mt-4">
        <Form.Item label="Titre" required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex : Visiteurs par appareil"
            maxLength={60}
          />
        </Form.Item>

        <Form.Item label="Type d'affichage">
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as Kind)}
            options={KIND_OPTIONS as unknown as { label: string; value: string }[]}
          />
        </Form.Item>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Form.Item label="Source de données">
            <Select
              value={table}
              onChange={(v: Table) => setTable(v)}
              options={TABLE_OPTIONS as unknown as { label: string; value: string }[]}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item label="Métrique" required>
            <MetricPicker value={metric} onChange={setMetric} />
          </Form.Item>
        </div>

        {(isDimensionTable || kind === 'metric_card') && (
          <Form.Item
            label={isDimensionTable ? 'Grouper par (dimension)' : 'Dimension (optionnelle)'}
            required={isDimensionTable}
          >
            <DimensionPicker
              value={dimension}
              onChange={setDimension}
              allowNone={!isDimensionTable}
            />
          </Form.Item>
        )}

        {isTimeSeries && (
          <Form.Item label="Granularité" required>
            <GranularityPicker value={granularity} onChange={setGranularity} />
          </Form.Item>
        )}

        {isDimensionTable && (
          <Form.Item label="Nombre de lignes">
            <InputNumber
              min={1}
              max={100}
              value={limit}
              onChange={(v) => setLimit(v ?? 10)}
            />
          </Form.Item>
        )}

        <Form.Item label="Filtres (optionnels)">
          <FilterEditor value={filters} onChange={setFilters} />
        </Form.Item>

        {validationError && title.length > 0 && (
          <Alert type="info" showIcon message={validationError} className="mt-2" />
        )}
      </Form>
    </Modal>
  )
}
