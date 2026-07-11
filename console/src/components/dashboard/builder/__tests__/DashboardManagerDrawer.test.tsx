import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import type { ReactNode } from 'react'
import { DashboardManagerDrawer } from '../DashboardManagerDrawer'
import type { DashboardLayout, DashboardWidget } from '../../../../types/workspace'

// Mock du client API : on capture l'appel workspaces.update.
const updateMock = vi.fn().mockResolvedValue({})
vi.mock('../../../../lib/api', () => ({
  api: { workspaces: { update: (...a: unknown[]) => updateMock(...a) } },
}))

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <App>{node}</App>
    </QueryClientProvider>,
  )
}

const WIDGETS: DashboardWidget[] = [
  { id: 'w1', kind: 'metric_card', title: 'Visiteurs FR', metric: 'unique_visitors', table: 'sessions' },
]
const LAYOUT: DashboardLayout = { widgets: WIDGETS, hidden_widgets: ['campaigns'] }

describe('DashboardManagerDrawer', () => {
  beforeEach(() => updateMock.mockClear())

  it('liste les widgets custom existants', () => {
    wrap(
      <DashboardManagerDrawer
        open
        onClose={vi.fn()}
        workspaceId="ws1"
        layout={LAYOUT}
      />,
    )
    expect(screen.getByText('Visiteurs FR')).toBeInTheDocument()
  })

  it('persiste le layout via workspaces.update au clic sur Enregistrer', async () => {
    const onClose = vi.fn()
    wrap(
      <DashboardManagerDrawer
        open
        onClose={onClose}
        workspaceId="ws1"
        layout={LAYOUT}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const arg = updateMock.mock.calls[0][0]
    expect(arg.id).toBe('ws1')
    expect(arg.settings.dashboard_layout.widgets).toHaveLength(1)
    // hidden natif préservé, order = ids custom.
    expect(arg.settings.dashboard_layout.hidden_widgets).toContain('campaigns')
    expect(arg.settings.dashboard_layout.order).toEqual(['w1'])
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('masquer un natif l\'ajoute à hidden_widgets à l\'enregistrement', async () => {
    wrap(
      <DashboardManagerDrawer
        open
        onClose={vi.fn()}
        workspaceId="ws1"
        layout={{ widgets: [] }}
      />,
    )
    // Le switch "Pages les plus consultées" est coché par défaut (visible).
    const row = screen.getByText('Pages les plus consultées').closest('li')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLElement
    fireEvent.click(toggle) // masque
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    const arg = updateMock.mock.calls[0][0]
    expect(arg.settings.dashboard_layout.hidden_widgets).toContain('pages')
  })
})
