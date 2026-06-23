# provisionTenant : workspace orphelin non nettoyé si la création de la clé API échoue

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

`provisionTenant` (`admin-platform.service.ts:168-242`) a une compensation
(`softDeleteUserSilently`) qui couvre l'échec workspace OU api-key dans le même
`try`. MAIS si `workspacesService.create` réussit et que `apiKeysService.create`
throw ensuite, on soft-delete **seulement le user** — le **workspace créé reste en
base, orphelin** (sans owner valide, sans clé).

Au prochain `provisionTenant` avec le même `name`, le résolveur de collision de
slug verra ce workspace fantôme et suffixera `_2` → dérive de slug + état sale non
réconcilié.

## Localisation (fichiers + lignes)

- `api/src/admin-platform/admin-platform.service.ts:168-242` — flow provisionTenant + compensation partielle

## Correctif proposé

En cas d'échec api-key après création workspace réussie, compenser AUSSI le
workspace (soft-delete ou `status='error'`). À minima, envelopper workspace et
apiKey dans deux try distincts et compenser le workspace si la clé échoue.

## Impact si non corrigé

Workspace zombie non nettoyé + dérive de slug à chaque retry sur le même nom.
Fréquence faible (apiKeys.create échoue rarement) mais laisse un état incohérent
non réconcilié dans la DB.
