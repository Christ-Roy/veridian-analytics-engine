# 🔴 La dimension `channel` n'est JAMAIS calculée → filtre/funnel par canal borgne

> **Sévérité** : 🔴 P1 (prérequis du funnel par canal — sans ça, le filtre canal est mort)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-22
> **Axe** : attribution / funnel par canal

## Constat (prouvé par le code)

La dimension **`channel`** (ads/seo/social/direct/…) et **`channel_group`** existent
de bout en bout MAIS ne sont **jamais remplies** :

- Schéma OK : `channel LowCardinality(String) DEFAULT ''` sur `events`/`sessions`/
  `goals` + propagé par les MV (`api/src/database/schemas.ts:354,438,518,647,733`).
- Dimension OK : `channel` + `channel_group`, catégorie `'Channel'`
  (`api/src/analytics/constants/dimensions.ts:80,87`) → visibles dans l'UI.
- **MAIS à l'ingestion, c'est hardcodé vide** :
  `api/src/events/session-payload.handler.ts:319-320` →
  ```ts
  // Defaults
  channel: '',
  channel_group: '',
  ```
- **Aucune fonction de dérivation** (`grep deriveChannel|classifyChannel|computeChannel`
  = 0). Le channel n'est calculé NULLE PART.

Conséquence : grouper/filtrer par `channel` renvoie tout dans `''` (vide). Le
**filtre par canal** demandé par Robert (« savoir s'ils viennent de l'ads, du seo,
ou d'autres canaux ») est **inopérant** aujourd'hui, alors que la donnée source est
là (utm_medium, gclid/gbraid/wbraid via `utm_id_from`, referrer/referrer_domain,
is_direct).

## Demande (calculer le channel à l'ingestion)

Ajouter une **dérivation déterministe** du `channel`/`channel_group` dans le
`session-payload.handler` (ou un util `derive-channel.ts`), à partir des signaux
déjà captés, selon une logique type "Default Channel Grouping" (inspirée GA4) :

| channel | Règle (ordre de priorité) |
|---|---|
| `paid_search` (ads) | `utm_id_from ∈ gclid/gbraid/wbraid` OU `utm_medium ∈ cpc/ppc/paid` |
| `organic_search` (seo) | referrer = moteur de recherche (google/bing/…) SANS gclid |
| `paid_social` / `organic_social` | referrer réseau social (± utm_medium paid) |
| `email` | `utm_medium=email` OU referrer mail |
| `referral` | referrer externe non classé |
| `direct` | `is_direct` / pas de referrer |
| `other` | reste |

`channel_group` = regroupement large (Paid / Organic / Social / Direct / …).
Calculer une fois par session (le channel de la 1re visite = le channel d'acquisition).

## Points d'attention
- Décision : channel calculé à l'**ingestion** (figé dans la donnée, perf) — reco —
  OU au **query-time** (recalculable mais coûteux). Reco ingestion + une migration
  de backfill optionnelle pour l'historique (via `filter-compiler` qui sait déjà
  faire `channel = CASE…` en UPDATE rétroactif).
- Aligner les valeurs avec `phone_source` (seo/ads/direct/email/social/print/other)
  pour cohérence cross-surface (web channel ↔ appel phone_source).
- Tests : un event avec gclid → `paid_search` ; referrer google sans gclid →
  `organic_search` ; etc. (table de cas).

## C'est le PRÉREQUIS de :
- `2026-06-22-funnel-tunnel-de-vente-par-canal.md` (le funnel filtrable par canal)
- `2026-06-22-crm-distinction-ads-vs-seo.md` (déjà ouvert)
