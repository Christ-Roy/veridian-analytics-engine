import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WidgetBuilder } from '../WidgetBuilder'
import { WIDGET_SAFE_METRICS } from '../../widget-catalog'
import type { DashboardWidget } from '../../../../types/workspace'

function renderBuilder(initial: DashboardWidget | null = null) {
  const onSave = vi.fn()
  const onCancel = vi.fn()
  render(
    <WidgetBuilder open initial={initial} onSave={onSave} onCancel={onCancel} />,
  )
  return { onSave, onCancel }
}

describe('WidgetBuilder', () => {
  it('désactive Enregistrer tant qu\'aucun titre n\'est saisi', () => {
    renderBuilder()
    const ok = screen.getByRole('button', { name: 'Enregistrer' })
    expect(ok).toBeDisabled()
  })

  it('produit un widget metric_card valide au save', () => {
    const { onSave } = renderBuilder()
    // Le titre est le seul champ requis manquant (métrique pré-remplie).
    const titleInput = screen.getByPlaceholderText('Ex : Visiteurs par appareil')
    fireEvent.change(titleInput, { target: { value: 'Mon indicateur' } })

    const ok = screen.getByRole('button', { name: 'Enregistrer' })
    expect(ok).not.toBeDisabled()
    fireEvent.click(ok)

    expect(onSave).toHaveBeenCalledTimes(1)
    const widget: DashboardWidget = onSave.mock.calls[0][0]
    expect(widget.kind).toBe('metric_card')
    expect(widget.title).toBe('Mon indicateur')
    expect(widget.metric).toBe(WIDGET_SAFE_METRICS[0])
    expect(widget.table).toBe('sessions')
    expect(widget.id).toBeTruthy()
  })

  it('préremplit le formulaire en édition et conserve l\'id', () => {
    const initial: DashboardWidget = {
      id: 'ventes-abc',
      kind: 'dimension_table',
      title: 'Ventes par pays',
      metric: WIDGET_SAFE_METRICS[0],
      table: 'sessions',
      dimension: 'country',
      limit: 5,
    }
    const { onSave } = renderBuilder(initial)
    expect(screen.getByDisplayValue('Ventes par pays')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    const widget: DashboardWidget = onSave.mock.calls[0][0]
    expect(widget.id).toBe('ventes-abc') // id conservé en édition
    expect(widget.kind).toBe('dimension_table')
    expect(widget.dimension).toBe('country')
  })
})
