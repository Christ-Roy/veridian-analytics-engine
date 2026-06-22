# 🟡 Numéro de tél tracké (appel VoIP) remonté dans le CRM avec sa source

> **Sévérité** : 🟡 P1 · **Owner** : agent engine · **Créé** : 2026-06-22 · **CLAIR**

## Demande
Un appel entrant tracké (event `phone_call`, source attribuée via le numéro
appelé `phone_source`) doit remonter dans le CRM Twenty comme une activité/lead
avec **la source de l'appel** (seo/ads/direct). Aujourd'hui le connecteur pousse
les goals web ; vérifier qu'il pousse aussi les `phone_call` avec `phone_source`.

## À faire
- Vérifier dans `twenty-event-mapper.ts` si `goal_name='phone_call'` est mappé et
  s'il porte `phone_source` dans les properties Twenty.
- Sinon : ajouter le mapping (phone_call → timeline activity « appel » + source).
- Le lien appel↔Person : par numéro de tél ? par identité web si l'appelant a aussi
  visité ? (= recouvre l'attribution, cf review GMB pour les cas durs).
- Test E2E.

Lien : [[project_vague_p1_differenciateurs_prod]] (phone_source livré),
[[project_twenty_connector_native_proven]].
