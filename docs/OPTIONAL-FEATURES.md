# Optional features (débranchées du scope commercial)

> Sprint cleanup-veridian-scope, 2026-05-23.
> Décision Robert : le scope commercialisé de Veridian Analytics se limite à
> visiteurs uniques (staminads natif) + Calls (B-VOIP) + Search Console (A4).
> Les autres composants livrés au sprint giga sont conservés dans le code mais
> ne sont plus exposés dans l'UI.

## Composants débranchés (toujours dans le code)

Localisation : `console/src/veridian/_optional-features/`

| Composant | Fichier | Pourquoi |
|---|---|---|
| Score Veridian | `service-score-block.tsx` | Métrique de "santé services" — hors scope payant |
| Shadow marketing | `shadow-marketing-block.tsx` | Sales banner pour services non actifs — sortie du tunnel marketing |
| Locked service page | `locked-service-page.tsx` | Pleine page d'upsell par service |
| Demo coming-soon | `demo-coming-soon.tsx` | Placeholder pour démo publique — garde l'écran propre |
| Dashboard custom | `dashboard.tsx` | Tunnel marketing : score + shadow + tabs forms/gsc/push/calls |
| Tabs stubs | `dashboard-tabs/{forms,gsc,push}-tab.tsx` | Stubs "Bientôt" des features débranchées |

Les tests vivent dans `console/src/veridian/_optional-features/__tests__/`.

## Sous-route supprimée

L'ancienne sous-route `/_authenticated/workspaces/$workspaceId/veridian` a été
**supprimée**. Le lien "Veridian" dans la nav (desktop + mobile) a été retiré.
L'utilisateur reste sur le dashboard staminads natif (`/workspaces/$wsId`)
qui affiche les visiteurs uniques et les graphes natifs.

## Sous-routes ajoutées

| Route | Composant | Backend |
|---|---|---|
| `/workspaces/$wsId/calls` | `routes/_authenticated/workspaces/$workspaceId/calls.tsx` → `CallsTab` | bridge B-VOIP `/api/admin/tenant/:wsId/calls` |
| `/workspaces/$wsId/search-console` | `routes/_authenticated/workspaces/$workspaceId/search-console.tsx` | bridge A4 + endpoint settings GSC |

## Comment réactiver

Si Robert décide plus tard de re-commercialiser le Score ou la Shadow Marketing :

1. Restaurer la sous-route `workspaces/$workspaceId/veridian.tsx` qui pointe
   sur `VeridianDashboardPage` (le composant existe toujours dans
   `_optional-features/dashboard.tsx` — il faudra juste ajuster les imports
   des tabs et du theme).
2. Remettre le lien "Veridian" dans la nav `workspaces/$workspaceId.tsx`.
3. Si les tabs Forms / Push doivent revenir, voir aussi
   `docs/ARCHIVED-FEATURES.md` (Push) et restaurer le module Forms côté
   `veridian-bridge` (DROP migration `20260523000000_drop_forms_leads` à
   reverter — la migration garde la trace exacte du schéma à recréer).

## Pricing actuel

Aucune de ces optional features n'est dans le pricing commercialisé. Si elles
reviennent, mettre à jour `veridian-hub/docs/PRICING-VERIDIAN.md`.
