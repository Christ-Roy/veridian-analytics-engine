# Persistance UI des tunnels nommés (funnels self-service)

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-07-11
> **Contexte** : suite du système funnel A/B livré (613f0ae). Complète le
>   « gérer nous-même » côté funnel (pendant du widget self-service).

## Contexte

Le système de funnel interactif est livré (FunnelPanel : builder ad-hoc,
segment_by A/B/C, trapèze). Le backend a DÉJÀ tout pour persister des tunnels
NOMMÉS par workspace :
- `workspaces.update({settings:{funnels}})` (JWT user, merge-safe) — write path.
- `settings.funnels: WorkspaceFunnelDto[]` (name/label/steps 2..8/defaults).
- M2M `funnels.set/get/run` (admin) en miroir.

MAIS côté console, il MANQUE :
1. Le type `funnels` dans `console/src/types/workspace.ts` `WorkspaceSettings`
   (absent — à ajouter en miroir du backend WorkspaceFunnelDto).
2. L'UI de gestion : « Enregistrer ce tunnel » depuis FunnelPanel + un sélecteur
   « Mes tunnels » pour recharger une définition sauvegardée + éditer/supprimer.
   Même pattern que `DashboardManagerDrawer` (persist via workspaces.update).

## Demande

1. Ajouter `funnels?: WorkspaceFunnel[]` à `WorkspaceSettings` (console) +
   types `WorkspaceFunnel`/`WorkspaceFunnelStep` (miroir backend).
2. FunnelPanel : bouton « Enregistrer ce tunnel » (nom + label) → append à
   `settings.funnels` via workspaces.update (merge-safe) + invalidate workspace.
3. Sélecteur « Mes tunnels » : charge une définition (steps) dans le builder.
4. Gestion (renommer/supprimer) — réutiliser le pattern manager drawer.

## Critère

Un utilisateur définit un tunnel « Onboarding », le sauvegarde, le recharge
plus tard en 1 clic, le compare par variante. Persisté par workspace.
