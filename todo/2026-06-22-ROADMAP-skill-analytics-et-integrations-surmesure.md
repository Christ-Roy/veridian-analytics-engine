# 🗺️ ROADMAP — Skill `analytics` (enfant) + intégrations sur-mesure pilotables IA

> **Sévérité** : 🟡 P1 (cap produit Robert 2026-06-22)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-22
> **Type** : INDEX / roadmap — découpe en sous-tickets

## Vision (Robert 2026-06-22)

Structurer l'analytics en **skill `analytics` enfant d'un futur skill parent
`manage-veridian`** (le parent viendra quand 2-3 enfants existeront — pas
maintenant). Le skill analytics = **un index de tout ce qu'il y a à faire**, avec
des parties claires :

1. **Config de base du compte + creds** (sur-mesure pilotable IA)
2. **SDK** (tracking, snippet, identité)
3. **Envoi des data analytics → Google Ads en S2S** (conversions/ROAS)
4. **Intégrations sur-mesure avec les autres services Veridian** (CRM, GMB…)

Principe directeur : **automatiser ce qui peut l'être, sur-mesure pilotable IA pour
ce qui doit l'être** (ex : poser les creds = sur-mesure, fait via l'API M2M).

## Sous-tickets — CLAIRS (priorité, racine todo/)

- `2026-06-22-skill-analytics-enfant-index.md` — restructurer le skill
  `analytics-provision` → skill `analytics` avec index (config/creds, SDK, Ads,
  intégrations). Base = le skill actuel déjà recâblé M2M. **CLAIR.**
- `2026-06-22-ads-conversions-upload-s2s.md` — F2 : uploader les conversions
  vers Google Ads API (l'engine EXPOSE déjà via `ads.conversions`, reste l'upload
  par le skill `google-ads` plateforme). **CLAIR sur le QUOI, quelques arbitrages
  techniques** (mapping workspace→customer_id, OAuth) → cf review.
- `2026-06-22-crm-distinction-ads-vs-seo.md` — le connecteur Twenty pousse
  `utmSource` brut mais PAS de distinction nette Ads/SEO ni le `phone_source`.
  Câbler : chaque prospect/appel poussé au CRM porte sa **source d'acquisition**
  (ads / référencement naturel / direct…) lisible dans Twenty. **CLAIR** (briques
  existent : phone_source, utm_id_from/gclid, connecteur natif).
- `2026-06-22-tel-tracke-vers-crm-avec-source.md` — numéro de tél tracké (appel
  VoIP `phone_call`) remonté dans le CRM avec sa source. Vérifier le pipeline
  appel→Twenty (le connecteur pousse-t-il déjà les phone_call avec source ?).

## Sous-tickets — FLOUS (todo/review/, à cadrer avec Robert AVANT code)

- `review/2026-06-22-attribution-gmb-rapprochement-timestamp.md` — attribution
  GMB (Google My Business) par rapprochement de timestamps. Sujet R&D : fenêtre de
  matching, faux positifs, source GMB (API ? export ?), relier appel GMB ↔ visite
  web. **À reviewer ensemble.**
- `review/2026-06-22-forms-data-brute-vers-crm.md` — brancher les formulaires /
  data brute (champs form) vers le CRM. Flou : quels champs, quel mapping Twenty,
  dédup, le pipeline form actuel (goals staminads natifs `form_submission` vs
  ingestion dédiée ?). **À cadrer.**

## Note d'audit (état réel 2026-06-22)
- Connecteur Twenty natif EN PROD pousse score + timeline + `utmSource` brut
  (`twenty-event-mapper.ts:229`). PAS de `phone_source` ni distinction Ads/SEO
  explicite → c'est le trou principal pour la distinction CRM.
- `phone_source` (dim engine) + `utm_id_from` (gclid/gbraid/wbraid) existent en
  données. `ads.conversions` M2M expose les conversions attribuées (livré).
- Forms : `form_submission` = un goal staminads natif (pas de pipeline form dédié
  visible) → à confirmer dans le ticket review.

---

## Ajout 2026-06-22 — Funnel & attribution par canal (audité)

Nouveaux sous-tickets (après audit du terrain) :
- 🔴 `2026-06-22-channel-jamais-calcule-attribution-borgne.md` — **PRÉREQUIS** : la
  dimension `channel` existe (schéma+dict+UI) mais est **toujours vide** (hardcodée
  `''` à l'ingestion, aucune dérivation). Sans ce calcul, tout filtre/funnel par
  canal est borgne. **À faire en premier.**
- 🟡 `2026-06-22-funnel-tunnel-de-vente-par-canal.md` — funnel analytique (étapes +
  taux de passage) filtrable par canal. Aucun funnel n'existe aujourd'hui. Backend
  `windowFunnel()` CH + vue UI native.
- 🟡 `2026-06-22-taux-creation-conversion-par-app-et-canal.md` — taux de création de
  compte par app × canal. Briques : goals signup/app_started avec `properties.app`
  existent ; volet Hub à coordonner (cross-domain vitrine→signup).

Ordre : **channel (prérequis) → funnel → taux par app**. Le channel débloque les
deux autres ET le ticket CRM Ads/SEO.
