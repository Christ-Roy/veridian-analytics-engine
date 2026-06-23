# S5 — Upload des conversions attribuées vers la Google Ads API (offline conversions)

> **Sévérité** : 🟡 P1 (boucle ROAS fermée : prouver à Google Ads quels clics convertissent)
> **Owner** : agent veridian-analytics-engine + skill plateforme google-ads
> **Créé** : 2026-06-23
> **Extrait de** : CHANTIER-attribution-bout-en-bout (S1-S4 livrés prod v10, S5 restait noyé)

## Contexte
La chaîne attribution est livrée prod (vague 2, 2026-06-23) : channel dérivé à
l'ingestion (S1), funnel par canal (S2), conversions par canal (S3), source au CRM
Twenty (S4). L'engine EXPOSE déjà les conversions attribuées Ads via
`POST /api/admin/platform/ads.conversions` (events `utm_id_from ∈ gclid/gbraid/wbraid`
OU appels `phone_source='ads'`). **Mais personne ne les UPLOAD vers Google Ads.**

## Ce qui manque
Câbler l'**upload des conversions offline** vers la Google Ads API (offline conversion
import) : prendre les conversions exposées par `ads.conversions` et les pousser dans le
compte Google Ads du client avec leur `gclid`/`gbraid`/`wbraid` + valeur + timestamp.
C'est ce qui ferme la boucle ROAS : Google Ads apprend quels clics ont vraiment converti
(achat, RDV, appel) → optimise les enchères.

## Découpage
- **Côté engine** : RAS (déjà fait — `ads.conversions` expose). Éventuellement enrichir
  le payload exposé (valeur de conversion, conversion_action_name) si l'upload en a besoin.
- **Côté skill plateforme `google-ads`** (PAS l'engine — l'engine n'uploade pas, il
  expose) : consommer `ads.conversions` en M2M, mapper workspace → customer_id Google Ads,
  uploader via `UploadClickConversionsRequest`. Gérer OAuth/dev-token Google Ads, le
  mapping conversion_action, la dédup (ne pas ré-uploader une conversion déjà poussée).
- **Pré-requis** : chaque workspace doit déclarer son `customer_id` Google Ads + le
  `conversion_action` cible (config workspace, pilotable M2M via le moteur de customisation
  N4 si pertinent).

## Localisation
- Engine (expose) : `api/src/admin-platform/` route `ads.conversions` (déjà là)
- Skill : `~/.claude/skills/google-ads/` (upload offline conversions — voir si déjà un mode)
- Config workspace : customer_id + conversion_action mapping

## Impact si non fait
La donnée d'attribution est captée et lisible (dashboards, CRM) mais ne REMONTE jamais
à Google Ads → les campagnes Ads du client optimisent à l'aveugle, le ROAS n'est pas
prouvé côté Google. C'est le dernier maillon de la promesse "je sais quel euro Ads
rapporte" — différenciateur commercial.
