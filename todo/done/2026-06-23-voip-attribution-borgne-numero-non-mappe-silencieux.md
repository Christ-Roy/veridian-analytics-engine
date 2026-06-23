# VoIP : numéro non mappé → attribué `direct` sans aucun signal (attribution borgne)

> **Sévérité** : 🟢 P2 (décision produit à trancher)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

La vision est "1 numéro = 1 source". Si un client a un appel sur un numéro qu'il
n'a pas (ou pas encore) mappé dans Settings → VoIP, l'event `phone_call` est quand
même créé mais attribué à `direct` (`voip.service.ts:360-363` commentaire "Numéro
inconnu → direct" ; `phone-call-event.ts:44` : `match?.source ?? 'direct'`).

Aucun log, aucun compteur, aucune trace (`properties.tracked_number_id` absente).
Côté Explore/Goals, ces appels polluent `direct` et l'utilisateur n'a aucun moyen
de savoir qu'un numéro lui manque dans la config.

NB : c'est peut-être un choix produit "default safe". À trancher par Robert.

## Localisation (fichiers + lignes)

- `api/src/voip/voip.service.ts:360-363` — numéro inconnu → `direct`
- `api/src/voip/phone-call-event.ts:44` — `match?.source ?? 'direct'`

## Correctif proposé

Si attribution voulue : OK, laisser. Sinon, ajouter
`properties.source_attributed = 'false'` (ou `properties.source = 'unmapped'`)
quand `match === null`, pour pouvoir filtrer/alerter sans casser l'affichage.
Coût quasi nul.

## Impact si non corrigé

Sources de trafic téléphonique faussées vers `direct`, invisible pour le client →
contredit la promesse commerciale de la feature Calls. À arbitrer avec Robert.
