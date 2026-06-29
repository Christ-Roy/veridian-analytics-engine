# Durcir la coercion ClickHouse — résidus `as number` non coercés (post-incident toFixed)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-29
> **Contexte** : suite de l'incident prod 2026-06-29 (crash `undefined.toFixed()`
>   sur tout le dashboard, fix b95e022). Audit multi-agent des régressions sœurs.

## Contexte

Cause racine commune de l'incident : `toMetricNumber`/`cellNumber` (coercion
des valeurs ClickHouse — sérialisées en **string**, parfois absentes) a été
introduite mais **pas propagée à tous les sites qui shapent des rows ClickHouse
bruts en types `number`** via un cast menteur `(row.x as number)`.

Le crash dur (DimensionTableWidget + explore-utils) est **déjà corrigé** en
b95e022. Restent des résidus **non bloquants** (NaN/affichage dégradé, pas de
crash) à nettoyer pour cohérence et propreté.

## Résidus à corriger

### 🟡 #2 — `BreakdownTable.tsx:79` : `bounce_rate` brut → "NaN%"

`dataSource={rows}` = `data.data` brut (rows ClickHouse non transformés).
`render: (v) => \`${(v * 100).toFixed(1)}%\`` sur `bounce_rate` → si absent,
`(undefined * 100).toFixed(1)` = `"NaN"` → affiche **"NaN%"** au client.
- **Fix** : `render: (v: unknown) => \`${((Number(v) || 0) * 100).toFixed(1)}%\``
- Fichier : `console/src/components/explore/BreakdownTable.tsx:79`

### 🟡 #3 — Heatmaps : `HeatmapDataPoint` non coercé → couleurs/max cassés

Casts menteurs sur rows ClickHouse bruts ; `TrafficHeatmapWidget` fait
`Math.max(...heatmapData.map(d => d[2]))` → `NaN` si string non purement
numérique → `maxValue` NaN → coloration heatmap cassée (pas de crash, tooltip
protégé par formatValue).
- **Fix** : coercer à la construction (`Number(row.x) || 0`).
- Fichiers : `console/src/components/dashboard/DashboardGrid.tsx:226-229`,
  `console/src/components/goals/GoalDashboardDrawer.tsx:130-132`

### 🟢 #4 — `DimensionTableWidget` : résidus `percent`/`maxValue` non coercés

6 sites non migrés vers `cellNumber()` lors du fix initial : largeur de barre
de fond (`width: ${percent}%` → `NaN%` ignoré par CSS) + `maxHeatMapValue`
potentiellement NaN. Cosmétique, jamais de crash.
- **Fix** : passer ces accès par `cellNumber()` (déjà défini dans le fichier).
- Fichier : `console/src/components/dashboard/DimensionTableWidget.tsx:87,91,96,99,247,509`

## Règle à poser (durcissement durable)

Idéalement appuyée par un lint custom ou un test :
> **Interdit d'écrire `(row.x as number)` sur une réponse analytics.**
> Toute métrique issue d'une réponse ClickHouse passe par `toMetricNumber`
> (ou `cellNumber` local). Le `as number` est un cast compile-time SANS
> conversion runtime — il laisse passer les strings ClickHouse.

## Critère

- Plus aucun `(row.* as number)` / `(row.* as number | undefined)` dans
  `console/src/components/**` et `console/src/lib/**` consommant des rows API.
- `grep -rn 'as number' console/src/components console/src/lib` → 0 hit sur
  des champs de row analytics (les autres `as number` légitimes documentés).
