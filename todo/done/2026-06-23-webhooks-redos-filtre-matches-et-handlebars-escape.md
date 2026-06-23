# Webhooks : ReDoS sur filtre `matches` + Handlebars escape HTML sur body JSON

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

Deux bugs de robustesse dans le pipeline webhook (filter + transform). Regroupés
car même périmètre, même agent.

## A. ReDoS sur l'opérateur de filtre `matches`

`new RegExp(filter.value).test(fieldValue)` compile et exécute une regex fournie
par l'opérateur du workspace, **sans timeout**, sur le thread d'event Node
(`webhook-filter-engine.ts:40-49`). La valeur vient de `WebhookFilterDto.value`
(type `unknown`, `dto/create-webhook.dto.ts:50-54`), ni bornée en longueur ni
validée comme regex sûre.

Une regex catastrophique (`(a+)+$`) sur un champ d'event un peu long bloque
l'event loop → DoS du dispatcher, qui tourne sur `event.tracked` et impacte donc
l'**ingestion analytics** (chemin chaud, process partagé multi-tenant).

**Correctif** : borner la longueur de `value` quand `op=matches`, et exécuter le
`RegExp.test` avec la lib `re2` (backtracking linéaire garanti, pas de
catastrophe) OU dans un worker thread avec timeout.

## B. Handlebars `noEscape: false` sur un body JSON → corruption silencieuse

`webhook-transform-engine.ts:53` configure Handlebars avec l'escaping HTML
**activé** (`noEscape: false`), mais le template rend un body **JSON**. Un champ
contenant `&`, `<`, `>`, `'`, `"` est transformé en `&amp;` etc. → JSON corrompu /
valeurs faussées chez le destinataire. Le helper `{{json this}}` contourne (SafeString),
mais un template naïf `{"email":"{{email}}"}` casse dès qu'un email/UTM contient un
caractère spécial.

**Correctif** : passer `noEscape: true` (le contexte de sortie est JSON, l'escaping
HTML n'a aucun sens ici), documenter que l'échappement JSON correct passe par
`{{json ...}}`.

## Localisation

- A : `api/src/webhooks/webhook-filter-engine.ts:40-49` + `dto/create-webhook.dto.ts:50-54`
- B : `api/src/webhooks/webhook-transform-engine.ts:53`

## Impact si non corrigé

A : auto-DoS par un owner de workspace, ralentit le process partagé sur le chemin
d'ingestion. B : payloads webhook silencieusement corrompus pour les destinations
en mode template avec données à caractères spéciaux.
