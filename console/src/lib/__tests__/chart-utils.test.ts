import { describe, it, expect } from 'vitest'
import {
  formatValue,
  formatAxisValue,
  formatNumber,
  formatDuration,
  formatCurrency,
} from '../chart-utils'

// Régression de l'incident prod 2026-06-29 : un widget configurable (table de
// dimensions) référençait une colonne absente de la ligne (`unique_visitors`
// renommée/désynchronisée du registre) → `row[col.key]` = undefined →
// `formatNumber(undefined)` → `undefined.toFixed(0)` → crash de TOUT le
// dashboard via ErrorBoundary, sur TOUS les workspaces. Aucun test ne couvrait
// `console/src/lib` (vitest était scopé sur src/veridian/** uniquement).
//
// Invariant garanti désormais : les fonctions de formatage bas niveau ne
// throwent JAMAIS, quelle que soit la valeur d'entrée (undefined/null/NaN/
// string ClickHouse). Une valeur non finie est traitée comme 0.

describe('chart-utils — robustesse contre les valeurs non finies (régression prod 2026-06-29)', () => {
  // Le cas exact qui a planté la prod : value = undefined, format = 'number'.
  const badInputs: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['string non numérique', 'abc'],
    ['objet', {}],
  ]

  describe('formatNumber', () => {
    it.each(badInputs)('ne throw pas et renvoie "0" pour %s', (_label, input) => {
      expect(() => formatNumber(input as number)).not.toThrow()
      expect(formatNumber(input as number)).toBe('0')
    })

    it('formate correctement les vraies valeurs', () => {
      expect(formatNumber(0)).toBe('0')
      expect(formatNumber(42)).toBe('42')
      expect(formatNumber(1500)).toBe('1.5K')
      expect(formatNumber(2_400_000)).toBe('2.4M')
    })

    it('accepte une string numérique ClickHouse', () => {
      expect(formatNumber('1500' as unknown as number)).toBe('1.5K')
    })
  })

  describe('formatValue', () => {
    it.each(badInputs)('format number — ne throw pas pour %s', (_label, input) => {
      expect(() => formatValue(input as number, 'number')).not.toThrow()
      expect(formatValue(input as number, 'number')).toBe('0')
    })

    it.each(badInputs)('format percentage — ne throw pas pour %s', (_label, input) => {
      expect(() => formatValue(input as number, 'percentage')).not.toThrow()
      expect(formatValue(input as number, 'percentage')).toBe('0.0%')
    })

    it.each(badInputs)('format duration — ne throw pas pour %s', (_label, input) => {
      expect(() => formatValue(input as number, 'duration')).not.toThrow()
    })

    it('formate correctement les vraies valeurs', () => {
      expect(formatValue(1500, 'number')).toBe('1.5K')
      expect(formatValue(12.345, 'percentage')).toBe('12.3%')
    })
  })

  describe('formatAxisValue', () => {
    it.each(badInputs)('ne throw pas pour %s (number)', (_label, input) => {
      expect(() => formatAxisValue(input as number, 'number')).not.toThrow()
    })
    it.each(badInputs)('ne throw pas pour %s (duration)', (_label, input) => {
      expect(() => formatAxisValue(input as number, 'duration')).not.toThrow()
    })
    it.each(badInputs)('ne throw pas pour %s (percentage)', (_label, input) => {
      expect(() => formatAxisValue(input as number, 'percentage')).not.toThrow()
    })
  })

  describe('formatDuration', () => {
    it.each(badInputs)('ne throw pas pour %s', (_label, input) => {
      expect(() => formatDuration(input as number)).not.toThrow()
    })
    it('formate correctement les vraies durées', () => {
      expect(formatDuration(30)).toBe('30s')
      expect(formatDuration(90)).toBe('1m 30s')
      expect(formatDuration(3700)).toBe('1h 1m')
    })
  })

  describe('formatCurrency', () => {
    it.each(badInputs)('ne throw pas pour %s', (_label, input) => {
      expect(() => formatCurrency(input as number, 'EUR')).not.toThrow()
    })
    it('formate une vraie valeur', () => {
      // narrowSymbol + locale par défaut du runner : on vérifie juste qu'un
      // montant fini produit une chaîne contenant le chiffre, sans throw.
      expect(formatCurrency(42, 'EUR')).toMatch(/42/)
    })
  })
})
