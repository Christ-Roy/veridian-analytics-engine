# Injection SQL ClickHouse via le champ `timezone` (query-builder)

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

Le champ `timezone` de `AnalyticsQueryDto` est validé uniquement par `@IsString()`
(`api/src/analytics/dto/analytics-query.dto.ts:184-186`) — **aucune whitelist,
aucune regex, aucune validation contre la liste des fuseaux IANA**.

Cette valeur descend telle quelle dans le query-builder où elle est **interpolée
directement dans le SQL ClickHouse** (chaînes littérales `'${tz}'`), sans binding
de paramètre :

```ts
// api/src/analytics/lib/query-builder.ts:18-44
hour:  { expr: (dateCol, tz) => `toStartOfHour(${dateCol}, '${tz}')` ... }
day:   { expr: (dateCol, tz) => `toDate(${dateCol}, '${tz}')` ... }
week:  { expr: (dateCol, tz) => `toStartOfWeek(${dateCol}, 1, '${tz}')` ... }
month: ... `toStartOfMonth(${dateCol}, '${tz}')` ...
year:  ... `toStartOfYear(${dateCol}, '${tz}')` ...
```

Chemin complet : `analytics.service.ts:67` (`const tz = dto.timezone || workspace.timezone || 'UTC'`)
→ `buildAnalyticsQuery(queryDto, tz, ...)` (`:179`) → interpolation `'${tz}'`.

Un appelant (clé workspace `stam_live_*` OU la route M2M `analytics.query` du
Hub/bridge) qui envoie une requête avec `granularity` set et :

```json
{ "timezone": "UTC') OR 1=1 -- " }
```

casse la requête / injecte du SQL arbitraire ClickHouse dans le contexte de la DB
du workspace. La granularité est nécessaire pour atteindre le code vulnérable
(`if (granularity) { ... g.expr(..., tz) }`), mais c'est un usage normal (tout
graphe time-series passe par là).

Surface réelle : tout détenteur d'une clé workspace peut injecter dans **sa
propre** DB ClickHouse (DB-per-workspace, donc pas de fuite cross-tenant
directe), MAIS : exfiltration via `system.*` tables accessibles, lecture de
métadonnées serveur, DoS par requête lourde, et selon les droits du user
ClickHouse applicatif, potentiellement plus. C'est une injection SQL authentifiée
non bornée — sévérité P0 par principe (jamais d'interpolation de string user en SQL).

## Localisation (fichiers + lignes)

- `api/src/analytics/dto/analytics-query.dto.ts:184-186` — validation insuffisante (`@IsString()` seul)
- `api/src/analytics/lib/query-builder.ts:14-45` — interpolation `'${tz}'` dans 5 expressions de granularité
- `api/src/analytics/analytics.service.ts:67` et `:356` — résolution du `tz` (inclut `dto.timezone`)

## Correctif proposé

1. **Whitelist au DTO** : valider `timezone` contre la liste IANA. Le plus simple
   et robuste : `Intl.supportedValuesOf('timeZone')` (Node 18+) dans un
   `@Validate` custom, OU une regex stricte `^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$`
   PLUS un test `try { Intl.DateTimeFormat(undefined, { timeZone: tz }) }`.
   Rejeter (400) toute valeur non reconnue.
2. **Défense en profondeur dans le query-builder** : re-valider `tz` avant
   interpolation (fonction `assertValidTimezone(tz)` qui throw), pour que même un
   appel interne malformé ne puisse pas injecter. ClickHouse ne permet pas de
   binder un nom de timezone en paramètre `{x:String}` dans `toDate(col, tz)` de
   façon triviale → la whitelist stricte est la bonne barrière.
3. Idem pour `workspace.timezone` (stocké en DB) : il est settable via
   `workspaces.updateSettings` M2M — valider à l'écriture aussi.

## Impact si non corrigé

Injection SQL ClickHouse authentifiée sur toute requête analytics time-series.
Exploitable par n'importe quel client porteur d'une clé workspace ou via la route
M2M. Trou de sécu classé P0 (OWASP A03). À corriger en priorité.
