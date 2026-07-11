import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MetricPicker, DimensionPicker, FilterEditor } from '../field-pickers'
import type { Filter } from '../../../../types/analytics'

describe('field-pickers — pickers catalog-driven réutilisables', () => {
  it('MetricPicker rend sans crash avec un placeholder', () => {
    render(<MetricPicker onChange={vi.fn()} />)
    expect(screen.getByText('Métrique')).toBeInTheDocument()
  })

  it('DimensionPicker expose l\'option "aucune" quand allowNone', () => {
    render(<DimensionPicker onChange={vi.fn()} allowNone />)
    // La valeur sélectionnée par défaut = l'option none (agrégat global).
    expect(screen.getByText('Aucune (agrégat global)')).toBeInTheDocument()
  })

  describe('FilterEditor', () => {
    it('ajoute un filtre par défaut au clic sur "Ajouter un filtre"', () => {
      const onChange = vi.fn()
      render(<FilterEditor value={[]} onChange={onChange} />)
      fireEvent.click(screen.getByText('Ajouter un filtre'))
      expect(onChange).toHaveBeenCalledWith([
        { dimension: '', operator: 'equals', values: [] },
      ])
    })

    it('supprime la ligne ciblée', () => {
      const onChange = vi.fn()
      const filters: Filter[] = [
        { dimension: 'device', operator: 'equals', values: ['desktop'] },
        { dimension: 'channel', operator: 'equals', values: ['ads'] },
      ]
      render(<FilterEditor value={filters} onChange={onChange} />)
      const removeButtons = screen.getAllByLabelText('Supprimer le filtre')
      expect(removeButtons).toHaveLength(2)
      fireEvent.click(removeButtons[0])
      expect(onChange).toHaveBeenCalledWith([
        { dimension: 'channel', operator: 'equals', values: ['ads'] },
      ])
    })

    it('masque le champ valeurs pour un opérateur sans valeur', () => {
      const filters: Filter[] = [
        { dimension: 'device', operator: 'isNotEmpty', values: [] },
      ]
      const { container } = render(
        <FilterEditor value={filters} onChange={vi.fn()} />,
      )
      // mode="tags" rend un combobox avec placeholder "Valeur(s)" — absent ici.
      expect(container.querySelector('[placeholder="Valeur(s)"]')).toBeNull()
    })
  })
})
