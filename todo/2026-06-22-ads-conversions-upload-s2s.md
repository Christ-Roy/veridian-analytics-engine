# 🟡 Upload des conversions → Google Ads API en S2S (F2)

> **Sévérité** : 🟡 P1 · **Owner** : agent engine + skill google-ads · **Créé** : 2026-06-22
> **CLAIR sur le QUOI, quelques arbitrages** (voir bas)

## Demande
Envoyer les conversions analytics → **Google Ads** en server-to-server pour le ROAS
réel. L'engine EXPOSE déjà les conversions attribuées (`POST /api/admin/platform/
ads.conversions` livré 2026-06-22, lecture des events gclid/gbraid/wbraid +
phone_source='ads'). Reste l'**upload** vers la Google Ads API.

## Design recommandé (règle d'or : pas de pipeline parallèle)
Le **skill plateforme `google-ads`** (qui gère déjà le compte Ads en IaC + a un
pipeline d'upload offline `ovh-calls-to-ads.py`, Enhanced Conversions for Leads,
SDK Python officiel, MCC 6437191896) **lit l'engine via `ads.conversions`** puis
**upload via la Google Ads API**. PAS de SDK Google Ads embarqué dans NestJS.

## Arbitrages à trancher (Robert) — peut aller en review si besoin
1. **Mapping `workspace_id → (customer_id Ads, conversion_action_id)`** : n'existe
   nulle part. Table engine sérialisée ? config skill ? = vrai manque structurel.
2. **OAuth multi-compte client** : 1 refresh token MCC Veridian aujourd'hui.
   Uploader sur le compte du client = compte sous MCC (login_customer_id) ou OAuth
   par client ? **Décision business.**
3. **Voie d'upload** : gclid-based (web) et/ou ECL phone-hash (appels).

## Note
ads.conversions (lecture) est FAIT. Ce ticket = la couche upload. Coordonner avec
le skill `google-ads`. Cf [[project_vision_2026-05-25_provisioning_telcalls]]
(« pas de Google Ads natif » → l'upload reste au skill plateforme, l'engine expose).
