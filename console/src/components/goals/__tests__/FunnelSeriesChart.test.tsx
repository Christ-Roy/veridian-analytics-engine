import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FunnelSeriesChart } from '../FunnelSeriesChart'
import type { FunnelStepResult } from '../../../types/analytics'

const STEPS: FunnelStepResult[] = [
  {
    step: 1,
    goal_name: 'account_created',
    label: 'Compte créé',
    count: 1000,
    value: 5000,
    conversion_from_previous: null,
    conversion_from_start: 100,
    dropoff_from_previous: 0,
  },
  {
    step: 2,
    goal_name: 'onboarding_complete',
    label: 'Onboarding complété',
    count: 600,
    value: 3000,
    conversion_from_previous: 60,
    conversion_from_start: 60,
    dropoff_from_previous: 400,
  },
  {
    step: 3,
    goal_name: 'first_order',
    label: '1ère commande',
    count: 150,
    value: 12000,
    conversion_from_previous: 25,
    conversion_from_start: 15,
    dropoff_from_previous: 450,
  },
]

describe('FunnelSeriesChart', () => {
  it('rend chaque étape avec son libellé', () => {
    render(
      <FunnelSeriesChart steps={STEPS} entered={1000} overallConversion={15} />,
    )
    // Les libellés apparaissent (dans le trapèze). getAllByText car label + tooltip.
    expect(screen.getAllByText('Compte créé').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Onboarding complété').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1ère commande').length).toBeGreaterThan(0)
  })

  it('affiche les taux de passage N→N+1 (sauf étape 1)', () => {
    render(
      <FunnelSeriesChart steps={STEPS} entered={1000} overallConversion={15} />,
    )
    expect(screen.getByText('60 %')).toBeInTheDocument()
    expect(screen.getByText('25 %')).toBeInTheDocument()
  })

  it('affiche les abandons entre étapes', () => {
    render(
      <FunnelSeriesChart steps={STEPS} entered={1000} overallConversion={15} />,
    )
    expect(screen.getByText('(400 abandons)')).toBeInTheDocument()
    expect(screen.getByText('(450 abandons)')).toBeInTheDocument()
  })

  it('en mode valeur, affiche les € par étape', () => {
    render(
      <FunnelSeriesChart
        steps={STEPS}
        entered={1000}
        overallConversion={15}
        metric="value"
      />,
    )
    // 12000 € formaté fr-FR = "12 000 €"
    expect(screen.getByText(/12\s?000 €/)).toBeInTheDocument()
  })

  it('affiche un titre + la conversion globale quand fourni (mode A/B)', () => {
    render(
      <FunnelSeriesChart
        steps={STEPS}
        entered={1000}
        overallConversion={15}
        title="Variante A"
        compact
      />,
    )
    expect(screen.getByText('Variante A')).toBeInTheDocument()
    expect(screen.getByText('15 %')).toBeInTheDocument()
  })

  it('ne crashe pas sur une série vide', () => {
    expect(() =>
      render(<FunnelSeriesChart steps={[]} entered={0} overallConversion={0} />),
    ).not.toThrow()
  })
})
