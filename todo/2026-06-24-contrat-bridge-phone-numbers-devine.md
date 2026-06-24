# Contrat endpoint bridge phone-numbers DEVINÉ (à confirmer avec l'agent bridge)

> **Sévérité** : 🟡 P1 (contrat inter-service non confirmé → risque silencieux)
> **Owner** : agent veridian-analytics-engine + agent bridge/VoIP
> **Créé** : 2026-06-24
> **Trouvé par** : hunt-archeo (TODO[phone-source-dim] non levé)

## Constat
`admin-platform.service.ts` → `forwardPhoneNumbersToBridge` (path provisioning)
appelle un endpoint du bridge dont le CONTRAT a été DEVINÉ, pas confirmé :
`POST {BRIDGE_URL}/api/admin/tenant/{workspaceId}/phone-numbers` body `{e164, source}`.
Un commentaire `TODO[phone-source-dim]` dans le code marque ce contrat comme non vérifié.

## Risque
Si le vrai contrat du bridge diffère (nom de route, shape du body, auth), le forward
de numéros au provisioning échoue SILENCIEUSEMENT (le code catch et met status 'failed'
mais le provisioning continue) → un client provisionné avec des numéros VoIP n'a pas
ses numéros côté bridge, et personne ne le voit. Régression silencieuse type.

## Correctif
1. Confirmer le vrai contrat de l'endpoint bridge phone-numbers (lire le code bridge
   `veridian-bridge/` OU demander à l'agent bridge/VoIP).
2. Aligner `forwardPhoneNumbersToBridge` sur le contrat réel (route, body, auth header).
3. Lever le TODO[phone-source-dim]. Ajouter un test contractuel.
4. Bonus : remonter une alerte (pas juste status 'failed' silencieux) si le forward échoue.

NB : un fix timeout sur ce fetch est traité séparément (hunt-finalize, fetch sans
AbortSignal.timeout). Ce ticket-ci = le CONTRAT, pas le timeout.

## Impact
Provisioning VoIP potentiellement cassé silencieusement chez un client → la feature
Calls (commercialisée) ne remonte pas les appels alors que tout paraît OK.
