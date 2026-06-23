# `properties` (goal) et `dimensions` non bornés dans le payload track

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

Dans `SessionPayloadDto`, les champs `properties` (Map d'un goal) et
`dimensions` sont validés par un simple `@IsObject()`
(`dto/session-payload.dto.ts:83-85` et `:227-229`). Aucune validation du nombre
de clés, de la longueur des valeurs, de la profondeur, ni du type string des
valeurs.

Un goal peut donc porter un `properties` de 10 000 clés ou des valeurs de
plusieurs Ko. `properties` est écrit **intégralement** en ClickHouse
(`deserializeGoal`, `session-payload.dto.ts:423` → `properties: action.properties ?? {}`)
et propagé aux webhooks/Twenty. (`dimensions` est moins grave : seuls `stm_1..10`
sont lus, le reste est stripé par `whitelist`.)

Combiné au cap body 100kb, le risque volumétrique unitaire reste borné, mais le
100kb devient le SEUL rempart — fragile, et ça gonfle le stockage et les payloads
sortants par event.

## Localisation (fichiers + lignes)

- `api/src/events/dto/session-payload.dto.ts:83-85` — `properties` (`@IsObject()` seul)
- `api/src/events/dto/session-payload.dto.ts:227-229` — `dimensions` (`@IsObject()` seul)
- `api/src/events/dto/session-payload.dto.ts:423` — écriture brute en sortie

## Correctif proposé

Borner `properties` (et `dimensions`) avec un validateur custom : plafonner le
nombre de clés (ex. 50), `MaxLength` par valeur (ex. 1024), forcer les valeurs en
string, rejeter sinon. Les constantes `MAX_PATH_LENGTH` / `MAX_GOAL_NAME_LENGTH`
existent déjà dans le DTO — appliquer la même rigueur.

## Impact si non corrigé

Gonflement non plafonné du stockage ClickHouse et des payloads webhook/Twenty par
event ; le cap body 100kb devient l'unique limite (ne pas augmenter ce cap sans
border `properties` au préalable).
