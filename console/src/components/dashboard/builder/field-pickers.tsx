/**
 * Pickers RÉUTILISABLES pilotés par le catalogue widget-safe (VAGUE 2).
 *
 * Socle « modulaire » commun au WidgetBuilder (dashboard self-service) et aux
 * filtres du FunnelBuilder. Chaque picker est un composant contrôlé
 * (value + onChange) qui ne propose QUE des champs sûrs (whitelist
 * `widget-catalog.json` — user_id/visitor_id/fingerprint exclus par
 * construction). Aucune logique métier ici : uniquement de la sélection typée.
 *
 * Règle : on ne fabrique jamais un `<select>` de métrique/dimension à la main
 * ailleurs — on réutilise ces pickers pour garantir la même whitelist et les
 * mêmes libellés FR partout.
 */
import { Select, Button, Space, Input } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import {
  WIDGET_SAFE_METRICS,
  WIDGET_SAFE_DIMENSIONS,
  WIDGET_GRANULARITIES,
  widgetMetricLabel,
  widgetDimensionLabel,
} from '../widget-catalog'
import {
  FILTER_OPERATORS,
  type Filter,
  type FilterOperator,
  type Granularity,
} from '../../../types/analytics'

/** Libellés FR des granularités (source unique — alignés sur chart-utils). */
const GRANULARITY_LABELS: Record<string, string> = {
  hour: 'Horaire',
  day: 'Journalier',
  week: 'Hebdomadaire',
  month: 'Mensuel',
  year: 'Annuel',
}

/** Libellés FR des opérateurs de filtre (dense, lisibles par un non-technique). */
const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'est',
  notEquals: "n'est pas",
  in: 'parmi',
  notIn: 'pas parmi',
  contains: 'contient',
  notContains: 'ne contient pas',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  isNull: 'est nul',
  isNotNull: 'non nul',
  between: 'entre',
  isEmpty: 'est vide',
  isNotEmpty: 'non vide',
}

/** Opérateurs qui n'attendent AUCUNE valeur (le champ valeurs est masqué). */
const VALUELESS_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
])

// ── Metric ──────────────────────────────────────────────────────────────────

export function MetricPicker({
  value,
  onChange,
  disabled,
}: {
  value?: string
  onChange: (metric: string) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder="Métrique"
      style={{ minWidth: 180 }}
      options={WIDGET_SAFE_METRICS.map((m) => ({
        value: m,
        label: widgetMetricLabel(m),
      }))}
      showSearch
      optionFilterProp="label"
    />
  )
}

// ── Dimension ───────────────────────────────────────────────────────────────

export function DimensionPicker({
  value,
  onChange,
  allowNone,
  noneLabel = 'Aucune (agrégat global)',
  placeholder = 'Dimension',
  disabled,
}: {
  value?: string
  /** `undefined` quand `allowNone` et l'option « aucune » est choisie. */
  onChange: (dimension: string | undefined) => void
  allowNone?: boolean
  noneLabel?: string
  placeholder?: string
  disabled?: boolean
}) {
  const options = [
    ...(allowNone ? [{ value: '__none__', label: noneLabel }] : []),
    ...WIDGET_SAFE_DIMENSIONS.map((d) => ({
      value: d,
      label: widgetDimensionLabel(d),
    })),
  ]
  return (
    <Select
      value={value ?? (allowNone ? '__none__' : undefined)}
      onChange={(v) => onChange(v === '__none__' ? undefined : v)}
      disabled={disabled}
      placeholder={placeholder}
      style={{ minWidth: 180 }}
      options={options}
      showSearch
      optionFilterProp="label"
    />
  )
}

// ── Granularity ─────────────────────────────────────────────────────────────

export function GranularityPicker({
  value,
  onChange,
  disabled,
}: {
  value?: Granularity
  onChange: (g: Granularity) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder="Granularité"
      style={{ minWidth: 150 }}
      options={WIDGET_GRANULARITIES.map((g) => ({
        value: g,
        label: GRANULARITY_LABELS[g] ?? g,
      }))}
    />
  )
}

// ── Filter editor (liste de filtres {dimension, operator, values}) ───────────

/**
 * Éditeur d'une liste de filtres. Contrôlé : `value` = tableau de `Filter`,
 * `onChange` renvoie le nouveau tableau. Chaque ligne = dimension + opérateur
 * + valeurs (masquées pour les opérateurs sans valeur). Réutilisé par le
 * WidgetBuilder ET les filtres du FunnelBuilder.
 */
export function FilterEditor({
  value,
  onChange,
  disabled,
}: {
  value: Filter[]
  onChange: (filters: Filter[]) => void
  disabled?: boolean
}) {
  const update = (i: number, patch: Partial<Filter>) => {
    const next = value.map((f, idx) => (idx === i ? { ...f, ...patch } : f))
    onChange(next)
  }
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i))
  const add = () =>
    onChange([...value, { dimension: '', operator: 'equals', values: [] }])

  return (
    <div className="flex flex-col gap-2">
      {value.map((f, i) => {
        const valueless = VALUELESS_OPERATORS.has(f.operator)
        return (
          <Space key={i} align="start" wrap>
            <DimensionPicker
              value={f.dimension || undefined}
              onChange={(dim) => update(i, { dimension: dim ?? '' })}
              disabled={disabled}
            />
            <Select
              value={f.operator}
              onChange={(op: FilterOperator) =>
                update(i, {
                  operator: op,
                  values: VALUELESS_OPERATORS.has(op) ? [] : f.values,
                })
              }
              disabled={disabled}
              style={{ minWidth: 130 }}
              options={FILTER_OPERATORS.map((op) => ({
                value: op,
                label: OPERATOR_LABELS[op],
              }))}
            />
            {!valueless && (
              <Select
                mode="tags"
                value={(f.values ?? []).map((v) => String(v ?? ''))}
                onChange={(vals: string[]) => update(i, { values: vals })}
                disabled={disabled}
                placeholder="Valeur(s)"
                style={{ minWidth: 180 }}
                tokenSeparators={[',']}
              />
            )}
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => remove(i)}
              disabled={disabled}
              aria-label="Supprimer le filtre"
            />
          </Space>
        )
      })}
      <div>
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          onClick={add}
          disabled={disabled}
          size="small"
        >
          Ajouter un filtre
        </Button>
      </div>
    </div>
  )
}

// Ré-exports pratiques pour les consommateurs (un seul point d'import).
export { GRANULARITY_LABELS, OPERATOR_LABELS }
