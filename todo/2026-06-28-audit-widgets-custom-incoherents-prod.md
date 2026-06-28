# Auditer les widgets custom incohérents déjà persistés en prod

> **Sévérité** : 🔵 P3
> **Owner** : agent analytics-engine
> **Créé** : 2026-06-28

## Contexte

Robert a vu "Pages les plus consultées" cassé. Diagnostic lead : un widget custom
`dashboard_layout.widgets[]` configuré `{table:'pages', metric:'pageviews'}` →
`pageviews` est une métrique de la table `sessions`, PAS `pages`. Au runtime,
`analytics.widgetData` renvoyait 400 `Metric pageviews is not available for table
pages` et le widget cassait dans l'UI.

## Ce qui a été fait (lot WC, 2026-06-28)

Durcissement de la validation `setLayout` : le validateur croise désormais
`metric × table` ET `dimension × table` contre les constantes **autoritaires**
`METRICS[m].tables` / `DIMENSIONS[d].tables` (la même source que le runtime
query-builder), en plus de la whitelist widget-safe. Un widget incohérent est
rejeté en 400 `INVALID_WIDGET_CONFIG` **à la persistance**, jamais au runtime.
Le chemin preset de provisioning a aussi été blindé (drop `widgets[]` invalide).

Donc : **plus aucun nouveau widget incohérent ne peut être persisté.**

## Ce qui reste (cet audit)

Vérifier qu'aucun workspace prod n'a DÉJÀ un widget custom incohérent persisté
AVANT ce fix (théoriquement impossible via l'API setLayout qui validait déjà le
cross-table, et les presets ne portent que `order` — mais à confirmer côté data).

### Procédure (read-only d'abord)

1. Pour chaque workspace prod : `POST /api/admin/platform/workspaces.getCustomization`
   (Bearer `ANALYTICS_ENGINE_PROD_VERIDIAN_ADMIN_API_KEY`) → lire
   `dashboard_layout.widgets[]`.
2. Pour chaque widget : vérifier `METRICS[w.metric].tables.includes(w.table)` et
   `DIMENSIONS[w.dimension].tables.includes(w.table)`.
3. Si un widget incohérent existe → le corriger via `setLayout` (full-replace du
   `widgets[]` nettoyé) ou le retirer. NE PAS toucher la prod sans relire l'état.

### Note

Le garde-fou défensif de `widgetData` renvoie déjà un 400 propre
`INVALID_WIDGET_CONFIG` sur un widget stocké incohérent (au lieu d'un throw
query-builder), donc même un éventuel widget legacy ne crashe pas le service —
il est juste invisible. Cet audit sert à le NETTOYER, pas à éteindre un incendie.

Pas d'endpoint M2M "list all workspaces" aujourd'hui → soit on itère sur les IDs
connus (vrd_veridian_site_prod, clients), soit on ajoute un `workspaces.list`
read-only (autre ticket).
