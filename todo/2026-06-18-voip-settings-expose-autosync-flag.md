# 🟢 VoIP : exposer `autoSyncEnabled` dans `voip.settings` (état du cron)

> **Sévérité** : 🟢 P2 — confort UI, contournable par le bandeau statique
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-18
> **Demandeur** : agent A2 (câblage bouton « Synchroniser maintenant », ticket
> 2026-06-17-configui-voip-sync-manuel-non-cable)

## Contexte

Le câblage du bouton « Synchroniser maintenant » est livré côté front
(`console/src/veridian/settings-panels/voip-panel.tsx`). La synchro manuelle
fonctionne et donne un feedback immédiat.

En revanche, l'état de la **synchro automatique** (le cron
`VoipSyncService.scheduledSync`, gated sur `VOIP_SYNC_ENABLED === 'true'`)
n'est exposé **nulle part** côté API. Le panel ne peut donc pas dire à
l'utilisateur si ses appels remontent tout seuls ou non.

Faute de flag, le front affiche aujourd'hui un **bandeau statique** :
« La synchro automatique remonte vos appels toutes les 15 minutes (si elle est
activée sur votre instance) ». C'est conservateur mais imprécis : si
`VOIP_SYNC_ENABLED` n'est pas set sur l'instance, la feature Calls est
**silencieusement morte** (aucune synchro auto), et l'utilisateur ne le sait
pas — il croit que ça tourne.

## Demande précise

Faire renvoyer par `GET /api/voip.settings` un flag booléen `autoSyncEnabled`,
lu depuis `VOIP_SYNC_ENABLED` (même source de vérité que le cron, pour rester
cohérent : pas de divergence possible entre l'affichage et le comportement
réel).

### Fichiers concernés

- `api/src/voip/voip.controller.ts` — méthode `settings()` (~ligne 55) :
  ajouter `autoSyncEnabled` au payload retourné. Lire la valeur via
  `ConfigService.get<string>('VOIP_SYNC_ENABLED') === 'true'` (idéalement
  réutiliser une méthode publique exposée par `VoipSyncService.enabled()`
  plutôt que dupliquer la lecture de l'ENV, pour garantir une seule source de
  vérité).
- `api/src/voip/voip-sync.service.ts` — exposer `enabled()` en `public` (ou
  un getter `isAutoSyncEnabled()`), aujourd'hui `private`.
- Tests : étendre le spec de `voip.settings` (ou ajouter un cas) pour vérifier
  que `autoSyncEnabled` reflète bien `VOIP_SYNC_ENABLED`.

### Côté front (à recâbler une fois le flag dispo)

Dans `console/src/veridian/settings-panels/voip-api.ts`, ajouter
`autoSyncEnabled: boolean` à l'interface `VoipSettingsResponse`. Dans
`voip-panel.tsx`, remplacer le bandeau statique du `CallsHint` par un message
conditionnel :
- `autoSyncEnabled === true` → « Synchro automatique active (toutes les 15
  minutes). »
- `autoSyncEnabled === false` → bandeau d'avertissement (ton `warning`) :
  « Synchro automatique désactivée sur cette instance — vos appels ne
  remontent que via "Synchroniser maintenant". » (le bouton manuel devient
  alors critique).

## Impact

- Sans le flag : l'utilisateur ne sait pas si la synchro auto tourne. Si
  `VOIP_SYNC_ENABLED` n'est pas set en prod, la feature Calls est morte sans
  aucun signal UI.
- Avec le flag : transparence totale + on peut alerter (ton warning) quand
  l'auto-sync est off, ce qui pousse l'utilisateur à utiliser le bouton manuel
  ou à demander l'activation côté infra.

## Action infra liée (hors périmètre de ce ticket front)

Vérifier que `VOIP_SYNC_ENABLED='true'` est bien set dans les composes Dokploy
**prod ET staging** de l'engine. Sinon les appels ne remontent jamais tout
seuls. (Note A2 : pas de default trouvé dans le code — le cron est désactivé
par défaut si l'ENV n'est pas présente.)
