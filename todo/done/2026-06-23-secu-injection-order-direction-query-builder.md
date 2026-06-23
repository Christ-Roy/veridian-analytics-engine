# Injection SQL ClickHouse via la direction de tri `order` (query-builder)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

Le champ `order` de `AnalyticsQueryDto` est `Record<string, 'asc' | 'desc'>`
mais validé seulement par `@IsObject()`
(`api/src/analytics/dto/analytics-query.dto.ts:188-190`). Le type TS `'asc'|'desc'`
n'est **pas appliqué au runtime** : aucune validation des valeurs.

Dans le query-builder, la **clé** (`field`) est correctement validée contre
`METRICS`/`DIMENSIONS` (bien), mais la **direction** (`dir`) est interpolée brute
via `.toUpperCase()` :

```ts
// api/src/analytics/lib/query-builder.ts:318-336
const additionalOrder = query.order
  ? Object.entries(query.order)
      .map(([field, dir]) => {
        if (METRICS[field]) return `${field} ${dir.toUpperCase()}`;        // dir interpolé
        if (DIMENSIONS[field]) return `${DIMENSIONS[field].column} ${dir.toUpperCase()}`;
        throw new Error(`Unknown order field: ${field}`);
      })
  ...
```

Même schéma dans `buildExtremesQuery` (via le même pattern d'order si présent).

Un appelant qui envoie :

```json
{ "order": { "sessions": "ASC, (SELECT ... ) " } }
```

injecte du SQL après le champ validé. Le `field` doit exister dans
METRICS/DIMENSIONS pour passer, mais une fois passé, la `dir` est libre.

Moins exploitable que le timezone (il faut un field valide et le résultat est
dans une clause ORDER BY), mais c'est une vraie injection authentifiée :
sous-requête, fonction lourde (DoS), ou bruit qui casse la requête.

## Localisation (fichiers + lignes)

- `api/src/analytics/dto/analytics-query.dto.ts:188-190` — `order` non validé runtime
- `api/src/analytics/lib/query-builder.ts:318-339` — `dir.toUpperCase()` interpolé (branche granularité ET branche order simple)

## Correctif proposé

1. Au DTO : remplacer `@IsObject()` par une validation custom qui vérifie que
   **chaque valeur** est strictement dans `['asc','desc']` (insensible à la casse),
   et rejette (400) sinon. Un `@Validate(OrderDirectionValidator)` qui itère les
   valeurs.
2. Défense en profondeur au query-builder : normaliser `dir` via une map
   `{ asc: 'ASC', desc: 'DESC' }` et throw si non trouvé, au lieu de
   `dir.toUpperCase()` brut.

## Impact si non corrigé

Injection SQL ClickHouse authentifiée dans la clause ORDER BY de toute requête
analytics avec tri custom. Vecteur secondaire au ticket timezone — à fixer dans
la même passe (les deux sont dans `query-builder.ts`).
