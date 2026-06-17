# ANALYTICS_REFERENCE.md : event phone_call absent + métrique pageviews documentée cassée

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : DOCUMENTER (compléter + corriger doc qui contredit le code)
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié)

`docs/ANALYTICS_REFERENCE.md` (la référence métriques/dimensions de l'API)
présente deux écarts doc↔code.

### 1. L'event `phone_call` — feature n°1 Veridian — n'est documenté nulle part

`grep -i 'voip|gsc|phone_call|téléphon'` dans `ANALYTICS_REFERENCE.md` =
**aucun résultat**. Or `phone_call` est, selon la VISION figée 2026-05-25
(`CLAUDE.md:36-52`), **LA vraie valeur différenciante Veridian** : le bridge
pousse un event `phone_call` natif staminads par appel, avec dimensions
`source` (seo/ads/gmb/flyer/direct) et `phone_number_e164`.

Cet event custom central — celui qui justifie la vente — n'apparaît :
- ni dans `ANALYTICS_REFERENCE.md` (dimensions/metrics),
- ni listé comme event custom de référence dans `docs/EVENTS-CUSTOM.md`
  (qui parle des events custom en général mais ne cite jamais `phone_call`
  comme l'event Veridian fondateur).

Un intégrateur ou un agent qui veut requêter/filtrer les appels par source
n'a aucune doc lui disant que `phone_call` existe, ni quelles dimensions il
porte (`source`, `phone_number_e164`).

### 2. La métrique `pageviews` est documentée comme fonctionnelle… alors qu'elle est CASSÉE

`ANALYTICS_REFERENCE.md:26` :

```
| `pageviews` | Total pageviews across all sessions | `countIf(name = 'screen_view')` | `3,456` |
```

Or cette métrique est **cassée** : la colonne `name` n'existe dans AUCUNE
table analytique (`sessions`/`pages`/`goals`) — elle est dans `events`, non
requêtable → ClickHouse renvoie `Unknown identifier 'name'`. C'est documenté
ailleurs comme bug connu :
- `docs/PLATFORM-ADMIN-API.md:135-143` (⚠️ « NE PAS utiliser la métrique
  `pageviews` … utiliser `page_count` sur la table `pages` »),
- ticket `todo/2026-06-17-fix-metric-pageviews-native-cassee.md`,
- memory `[[project_bridge_m2m_native_lot_b]]` (contournement page_count).

→ **Deux docs se contredisent** : ANALYTICS_REFERENCE dit « pageviews =
`countIf(name='screen_view')`, ça marche, ex 3,456 », PLATFORM-ADMIN-API dit
« pageviews est cassée, utilise page_count ». La référence officielle propage
la métrique buguée.

## Demande précise

1. **Ajouter une section `phone_call`** dans `ANALYTICS_REFERENCE.md` (ou
   l'ériger en exemple-phare dans `EVENTS-CUSTOM.md`) : nom de l'event,
   dimensions `source` (enum) + `phone_number_e164`, comment le requêter dans
   Explore/Goals. C'est l'event commercial central, il mérite une doc de
   référence.
2. **Corriger ou retirer la ligne `pageviews`** dans `ANALYTICS_REFERENCE.md` :
   soit documenter le bug + rediriger vers `page_count` (table `pages`), soit
   retirer la métrique tant qu'elle n'est pas fixée (cf ticket
   `2026-06-17-fix-metric-pageviews-native-cassee.md`). Ne pas laisser une
   référence présenter une métrique qui throw.

## Impact

(1) La feature qui justifie la vente (tracking d'appels par source) est
invisible dans la doc de référence — un intégrateur ne sait pas qu'elle existe
ni comment l'exploiter. (2) Un consommateur d'API (Hub, skill, client) qui suit
la référence et appelle `pageviews` se prend un 500 ClickHouse — la doc l'induit
en erreur.

## Liens

- Fix métrique : `2026-06-17-fix-metric-pageviews-native-cassee.md`
- Cartographie modules : `2026-06-17-doc-cartographie-modules-backend.md`
- Events custom : `docs/EVENTS-CUSTOM.md` ; Platform admin : `docs/PLATFORM-ADMIN-API.md:135`
