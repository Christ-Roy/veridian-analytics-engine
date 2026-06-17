# GSC : `searchType` (web/image/video) calculé mais non sélectionnable en UI

> **Sévérité** : 🔵 P3
> **Owner** : agent veridian-analytics (engine)
> **Créé** : 2026-06-17
> **Axe audit** : KPI/Dashboard — parité backend↔UI (mineur)

## Constat

Le service de query GSC supporte le filtrage par type de recherche (web /
image / video / news), mais l'UI le hardcode toujours sur `web`.

- `api/src/gsc/gsc-query.service.ts:96` → `dashboardSummary` accepte
  `searchType` (`opts.searchType ?? 'web'`) et le propage à tous les agrégats
  (totals + topQueries + topPages + timeseries).
- `api/src/gsc/gsc.controller.ts:64` → `GET /api/gsc/dashboard` n'expose PAS
  `searchType` en query param → il reste toujours à `'web'`.
- `console/src/veridian/gsc/api.ts` (`fetchGscDashboard`) ne passe jamais de
  `searchType` → le client ne voit que les performances web.

## Impact

Mineur. La majorité des clients Veridian (sites vitrine FR) ne se soucient que
du `web`. Mais un client e-commerce/visuel rate ses perfs Google Images. Pas
bloquant pour V1.

## Demande précise (si Robert valide — sinon laisser tel quel)

1. **Backend** — ajouter `searchType` optionnel au `GscDashboardQueryDto`
   (`api/src/gsc/dto/gsc.dto.ts`) et le passer à `dashboardSummary` dans le
   controller (`gsc.controller.ts:64`). Défaut `'web'` inchangé.
2. **UI** — un petit `<select>` web/image/video dans le
   `search-console-panel.tsx` (à côté du sélecteur de fenêtre déjà présent,
   ligne 411). Reste dans l'onglet Settings → Search Console existant, zéro
   page custom.

Faible priorité : à faire en passant si quelqu'un retouche le panel GSC, pas
un sprint dédié.
