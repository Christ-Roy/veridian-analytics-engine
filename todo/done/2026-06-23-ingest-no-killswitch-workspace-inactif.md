# `/api/track` ingère pour les workspaces inactifs/suspendus (pas de kill-switch)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

L'endpoint public `POST /api/track` résout le workspace via
`workspacesService.get(id)` qui ne lève QUE si 0 ligne trouvée. Le champ
`status` du workspace (`'initializing' | 'active' | 'inactive' | 'error'`,
`workspace.entity.ts:4`) n'est **jamais testé** avant l'écriture en ClickHouse.

Conséquence : un workspace désactivé, suspendu (client résilié) ou en erreur
**continue d'ingérer** et de consommer du stockage. Il n'existe aucun kill-switch
d'ingestion par workspace.

## Localisation (fichiers + lignes)

- `api/src/events/session-payload.handler.ts:54` — `getWorkspace()` ne vérifie que l'existence
- `api/src/workspaces/workspaces.service.ts:109-120` — `get()` lève seulement sur 0 ligne, ignore `status`

## Correctif proposé

Dans le handler (ou dans `getWorkspace`), rejeter silencieusement si
`workspace.status !== 'active'` : `return { success: true }` (réponse 200 muette
pour ne pas leaker l'état du tenant à un client externe, cohérent avec le
domain-reject déjà présent en `session-payload.handler.ts:64`).

## Impact si non corrigé

Un client suspendu/résilié continue de générer de la donnée facturée et de
consommer du stockage ; impossible de couper l'ingestion d'un workspace sans le
supprimer. Quick-win safe (~5 lignes).
