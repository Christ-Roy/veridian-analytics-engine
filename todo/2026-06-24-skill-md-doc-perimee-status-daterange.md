# SKILL.md analytics-provision : doc périmée (shape `status` + dateRange)

> **Sévérité** : 🟢 P3 (doc, le code est correct)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Source** : audit comportemental M2M (probe-contracts)
> **Note** : le SKILL.md est HORS-REPO (`~/.claude/skills/analytics-provision/SKILL.md`).
> Le code est la vérité et est correct — c'est la doc à corriger. À router vers le
> mainteneur du skill (ou Robert).

## 1. `workspaces.status` — shape doc ≠ réel

Le SKILL.md (section « Surface M2M IA-first ») annonce :
```
tracking{snippet, events_last_28d, active}
gsc{connected, site_url, last_sync}
```

Le **réel** (et le DTO `WorkspaceStatusResponseDto`, qui est la vérité) renvoie :
```json
"tracking": { "active": true, "sessions_30d": 146, "visitors_30d": 2, "live": true },
"gsc":      { "connected": false, "site_url": null, "ownership_state": null, "last_sync_at": null },
"voip":     { "configured", "phone_number_count", "phone_numbers", "last_sync_at", "credential_kinds" },
"webhooks": { "active_count", "webhooks":[{id,name,url,active}] },
"snippet_html": "<script ...>"   // ← snippet est au niveau RACINE, pas dans tracking
```

Divergences :
- `tracking.snippet` / `tracking.events_last_28d` **n'existent pas** ; le réel a
  `active, sessions_30d, visitors_30d, live`.
- le snippet est `snippet_html` **au niveau racine**, pas sous `tracking`.
- `gsc.last_sync` doc → `gsc.last_sync_at` réel, + champ `ownership_state` non documenté.

Reproduction : `analytics --env staging status vrd_veridian_site_staging`.

## 2. dateRange : deux conventions non flaguées comme piège

Le SKILL documente les deux formats mais ne signale pas que ce sont **deux
contrats incompatibles entre routes sœurs** :

| Route | Format date |
|---|---|
| `analytics.query`, `analytics.funnel`, `analytics.conversionsByChannel` | `dateRange:{ preset }` OU `dateRange:{ start, end }` |
| `ads.conversions` | `from` / `to` **ISO-8601 plats** (pas de `dateRange`, pas de `preset`) |

Un `dateRange:{preset:"all_time"}` accepté par `analytics.query` est ignoré/inconnu
par `ads.conversions` (qui veut `from`/`to`). Et `ads.conversions` rejette une date
non ISO-8601 (`{"from":"pas-une-date"}` → 400 "from must be a valid ISO 8601"),
alors que `analytics.query` accepte `dateRange.start:"2026-06-20"` (date simple).

**Correctif doc** : ajouter dans le SKILL un encadré « ⚠️ deux conventions de date »
qui dit clairement quelles routes prennent `dateRange{preset|start,end}` et lesquelles
prennent `from/to` ISO-8601, pour éviter qu'un agent copie le mauvais format.

## Ce qui est SAIN (vérifié, rien à corriger)

- `tracking.verify` : le shape documenté dans le SKILL correspond **exactement** au réel
  (`workspace_exists, ingestion{ok,round_trip_ms,detail}, snippet, real_tracking{sessions_30d,live}, verdict`).
  Le verdict `workspace_not_found` en **200** (pas 404) est conforme à la doc.
- Validation enums (`source`, `role`, `status`, `kind`, `transform.type`, `auth.type`,
  `identity_resolver`, `preset`) : toutes rejettent les valeurs hors-liste en **400 propre**.
- Auth M2M : 401 propre sans clé / clé invalide. 404 cohérent sur workspace inexistant
  (sauf `status` qui renvoie 200 `exists:false`, ce qui est voulu = check d'existence).
- Aucune erreur ne leake de stack trace. (Le SQL leaké par `analytics.query` fait
  l'objet d'un ticket séparé `2026-06-24-analytics-query-leak-sql-clickhouse.md`.)
