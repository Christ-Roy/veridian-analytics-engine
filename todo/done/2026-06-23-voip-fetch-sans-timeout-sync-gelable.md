# VoIP : fetch providers sans timeout → sync gelable à vie (arrêt silencieux)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

Aucun fetch des providers VoIP ne passe de `signal: AbortSignal.timeout(...)`
(`providers/ovh.ts:92,124` et `providers/telnyx.ts:113`). Le `fetch` global Node
n'a **pas** de timeout par défaut.

Si OVH ou Telnyx laisse une connexion pendante (TCP black-hole, lenteur),
l'appel bloque indéfiniment. Comme `VoipSyncService` protège les runs avec le flag
`this.running = true` relâché seulement dans le `finally` une fois `syncAll()`
résolu, **un seul fetch gelé bloque TOUS les syncs cron suivants** — le module
VoIP entier devient muet, sans erreur ni log.

## Localisation (fichiers + lignes)

- `api/src/voip/providers/ovh.ts:92,124` — `fetchImpl(...)` sans signal
- `api/src/voip/providers/telnyx.ts:113` — idem
- `api/src/voip/voip-sync.service.ts` — flag `running` relâché seulement après résolution complète

## Correctif proposé

Ajouter `AbortSignal.timeout(15000)` sur chaque fetch des providers (1-2 lignes
par call site). Idéalement aussi un `Promise.race` global par credential dans
`syncOne` pour borner le temps total d'un sync de ligne.

## Impact si non corrigé

Un incident réseau côté provider = arrêt silencieux de TOUTE l'ingestion d'appels
jusqu'au redémarrage du container. À fixer en priorité (P1 le plus urgent du
module VoIP).
