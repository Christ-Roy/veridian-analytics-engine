import { describe, it, expect } from 'vitest'
import { transformApiRowsToExploreRows } from '../explore-utils'

// Régression sœur de l'incident prod 2026-06-29 (audit multi-agent).
// transformApiRowsToExploreRows recevait des rows ClickHouse bruts où les
// agrégats numériques sont sérialisés en STRING. L'ancien code faisait
// `(row.x as number) ?? 0` — un cast purement compile-time : la string passait
// telle quelle (`?? 0` ne rattrape que null/undefined). En aval, ExploreTable
// fait `record.bounce_rate.toFixed(0)` → `"0.45".toFixed` n'existe pas →
// crash de la page Explore entière via ErrorBoundary, sur tout workspace dont
// ClickHouse renvoie ces métriques en string.
//
// Invariant garanti : toutes les métriques de ExploreRow sont des `number`
// finis (jamais string/undefined/NaN) côté période courante.

const DIMENSIONS = ['device']

describe('transformApiRowsToExploreRows — coercion ClickHouse string (régression prod 2026-06-29)', () => {
  it('coerce les métriques string ClickHouse en number', () => {
    const apiRows = [
      {
        device: 'Desktop',
        unique_visitors: '950',
        sessions: '1200',
        median_duration: '45.5',
        bounce_rate: '0.42',
        median_scroll: '78.3',
      },
    ]
    const [row] = transformApiRowsToExploreRows(apiRows, DIMENSIONS, 0, null, false)

    expect(typeof row.unique_visitors).toBe('number')
    expect(typeof row.sessions).toBe('number')
    expect(typeof row.bounce_rate).toBe('number')
    expect(row.unique_visitors).toBe(950)
    expect(row.sessions).toBe(1200)
    expect(row.bounce_rate).toBeCloseTo(0.42)
    // Le cas exact qui crashait : .toFixed sur la métrique ne doit pas throw.
    expect(() => (row.bounce_rate as number).toFixed(1)).not.toThrow()
  })

  it('tombe sur 0 quand une métrique est absente de la row', () => {
    const apiRows = [{ device: 'Mobile', sessions: '800' }] // pas de bounce_rate/etc.
    const [row] = transformApiRowsToExploreRows(apiRows, DIMENSIONS, 0, null, false)

    expect(row.unique_visitors).toBe(0)
    expect(row.bounce_rate).toBe(0)
    expect(row.median_scroll).toBe(0)
    expect(() => (row.bounce_rate as number).toFixed(1)).not.toThrow()
    expect((row.bounce_rate as number).toFixed(1)).toBe('0.0')
  })

  it('coerce aussi les métriques de période précédente (string → number)', () => {
    const apiRows = [
      {
        device: 'Desktop',
        unique_visitors: '1000',
        sessions: '1200',
        median_duration: '40',
        bounce_rate: '0.30',
        median_scroll: '70',
        unique_visitors_prev: '800',
        sessions_prev: '1000',
        bounce_rate_prev: '0.40',
        median_duration_prev: '35',
        median_scroll_prev: '60',
      },
    ]
    const [row] = transformApiRowsToExploreRows(apiRows, DIMENSIONS, 0, null, true)

    expect(typeof row.unique_visitors_prev).toBe('number')
    expect(row.unique_visitors_prev).toBe(800)
    // Le change% se calcule sans NaN.
    expect(row.unique_visitors_change).toBeCloseTo(25) // (1000-800)/800*100
  })

  it('laisse _prev undefined quand la période précédente est absente', () => {
    const apiRows = [
      { device: 'Desktop', unique_visitors: '1000', sessions: '1200', median_duration: '40', bounce_rate: '0.30', median_scroll: '70' },
    ]
    const [row] = transformApiRowsToExploreRows(apiRows, DIMENSIONS, 0, null, true)
    // hasPreviousPeriod=true mais aucune clé _prev → undefined, pas 0.
    expect(row.unique_visitors_prev).toBeUndefined()
    expect(row.unique_visitors_change).toBeUndefined()
  })
})
