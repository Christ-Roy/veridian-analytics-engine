# VoIP OVH : pull complet/échoué sur gros volume (signature, curseur, cap)

> **Sévérité** : 🟡 P1 (signature) + 🟢 P2 (curseur, cap)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

Trois problèmes liés du pull OVH, à traiter dans la même passe sur `syncOne` /
`fetchOvhCdr`.

## A. 🟡 P1 — Signature OVH calculée une fois, réutilisée sur jusqu'à 400k requêtes

`providers/ovh.ts:229` : le `timestamp` (`/auth/time`) est récupéré UNE fois puis
propagé dans tous les `ovhGet` (jusqu'à `MAX_LINES=200` ×
`MAX_CONSUMPTIONS_PER_LINE=2000` = 400 000 GET signés avec le même timestamp).
OVH applique une tolérance (~30s) autour de son heure serveur ; sur un compte à
fort volume, les requêtes tardives échouent en `401 OVH:QUERY_TIME_OUT` → le sync
de la ligne plante (`markSyncError`).

**Correctif** : re-fetcher le timestamp + re-signer toutes les ~N requêtes ou tous
les ~20s d'horloge écoulée (pas à chaque call, trop coûteux). Le port a hérité ça
du bridge sans tenir compte du volume réel d'un pull multi-lignes.

## B. 🟢 P2 — `last_sync_at` écrit mais jamais lu → re-pull 7 jours complet à chaque run (96×/jour)

`voip-sync.service.ts:98-127` : `lookbackDays()` retourne 7 en dur, `since` = now−7j
à chaque run. `voip.service.ts:238` persiste `last_sync_at` qui n'est **jamais
reconsulté** pour calculer `since`. Aucun curseur incrémental → chaque cron OVH
re-fetch le détail de jusqu'à 2000 consos/ligne sur 7 jours, toutes les 15 min.
Idempotent (pas de doublon) mais gâchis d'API massif qui aggrave le point A.

**Correctif** : `since = max(last_sync_at − overlap, now − defaultLookback)`. Le
champ existe déjà, le câbler dans `syncOne`.

## C. 🟢 P2 — Cap 2000 consos appliqué AVANT le filtre date → perte d'appels récents

`providers/ovh.ts:187` : `ids.slice(0, MAX_CONSUMPTIONS_PER_LINE)` tronque la
liste brute (ordre API non garanti chronologique) ; le filtre `since/until`
n'intervient qu'après, par-détail (`:207`). Une ligne avec >2000 consos dans la
fenêtre peut voir ses 2000 premiers IDs (potentiellement les plus vieux) consommer
tout le budget → appels récents ignorés (trous dans les events `phone_call`).

**Correctif** : filtrer/trier par date côté API OVH `/voiceConsumption` avant le
slice, ou trier les IDs avant cap.

## Impact si non corrigé

A : pull incomplet/échoué sur les comptes OVH chargés (petit client FR 1-2 lignes
non touché). B : coût/latence API, risque rate-limit provider. C : sous-comptage
d'appels sur gros volume.
