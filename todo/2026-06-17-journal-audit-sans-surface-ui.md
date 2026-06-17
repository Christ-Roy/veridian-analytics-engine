# Journal d'audit (`audit.list` / `audit.getByTarget`) calculé mais sans surface UI

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics (engine)
> **Créé** : 2026-06-17
> **Axe audit** : KPI/Dashboard — feature backend sans UI

## Constat (trou prouvé par le code)

Le module `audit` persiste un journal d'actions sensibles par workspace, le
sert via une API authentifiée workspace-scopée, mais **la console ne
l'appelle jamais** → traçabilité invisible au client.

Backend (calcul + exposition) :

- `api/src/database/schemas.ts:66` → table `audit_logs`.
- `api/src/audit/audit.controller.ts:14` → `GET audit.list` (filtres
  workspace_id / user_id / action / target_type, pagination) sous
  `WorkspaceAuthGuard` → c'est de la donnée **user-facing**, pas du M2M
  interne.
- `api/src/audit/audit.controller.ts:42` → `GET audit.getByTarget`
  (historique d'une cible précise, ex. une clé API ou un membre).
- `api/src/audit/audit.service.ts` calcule/filtre/pagine ces logs.

UI (affichage) — RIEN :

- `grep "audit.list\|audit.getByTarget"` sur `console/src/` → **0 résultat**.
  Le seul hit « audit » dans la console est une chaîne sans rapport
  (`api.ts:139` graphe appels). Aucun composant ne consomme le journal.
- Liste des endpoints réellement appelés par la console (grep des paths
  `api/*`) : on y trouve `apiKeys.*`, `members.*`, `workspaces.*`,
  `auth.*`, `gsc/*`, `voip.*`… mais **jamais `audit.*`**.

À noter pour contraste : `export.userEvents` et `tunnel.aggregate` sont eux
aussi absents de la console — mais c'est **by design** (contrats M2M
consommés par le bridge tunnel-de-vente / Twenty, jamais affichés). Le
journal d'audit, lui, est explicitement workspace-scopé JWT et raconte ce
que les membres du workspace ont fait : c'est de la donnée destinée à être
montrée.

## Impact

- Aucune visibilité pour le client (ni pour le support Veridian) sur « qui a
  révoqué cette clé API », « qui a retiré ce membre », « quand le rôle a
  changé » — alors que tout est déjà logué et requêtable.
- Manque de transparence/sécurité attendu d'un SaaS B2B (les actions
  destructives sur clés API et membres devraient être traçables côté UI).

## Demande précise (voie propre, conforme à la vision — onglet Settings, pas de page Veridian)

1. **UI** — ajouter une section/onglet « Activité » ou « Journal » dans
   Settings natif (extension du `z.enum section`, exactement comme les onglets
   VoIP / Search Console). Affiche `audit.list` filtré sur le workspace
   courant : table dense date / acteur / action / cible, avec pagination
   (offset/limit déjà supportés backend). Reste strictement dans le cadre
   « onglet Settings » autorisé par Robert (2026-05-23).

2. **Backend** — rien à créer : `audit.list` est prêt et workspace-scopé.
   Vérifier juste que le filtre `workspace_id` est bien appliqué côté guard
   (un membre ne doit voir QUE son workspace — confirmer dans
   `audit.service.ts` / `WorkspaceAuthGuard`).

## Arbitrage à confirmer par Robert

Le scope final figé 2026-05-23 = 3 features (visiteurs uniques + Calls + GSC).
Un journal d'audit n'en fait pas partie stricto sensu. Deux options :

- **A (reco ~60 %)** : brancher l'onglet « Activité » — petit effort, donnée
  déjà là, vraie valeur sécurité/transparence B2B.
- **B** : si Robert juge ça hors-scope V1, alors le module `audit` est du code
  backend mort côté produit → soit on assume (utile pour debug/support via
  API directe), soit on l'archive. À trancher, pas à laisser en limbe.
