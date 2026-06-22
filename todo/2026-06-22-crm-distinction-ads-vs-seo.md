# 🟡 CRM : distinguer prospects Google Ads vs référencement naturel

> **Sévérité** : 🟡 P1 · **Owner** : agent engine · **Créé** : 2026-06-22 · **CLAIR**

## Constat (audit 2026-06-22)
Le connecteur Twenty natif (en prod) pousse `props.utmSource = utm.source`
(`twenty-event-mapper.ts:229`) — donc l'utm_source BRUT, mais PAS une distinction
claire **Ads vs SEO** ni le `phone_source`. Dans Twenty, on ne peut pas filtrer
proprement « prospects venus de Google Ads » vs « du référencement naturel ».

## Briques existantes
- `utm_id_from ∈ gclid/gbraid/wbraid` = signal Ads fort (capté, stocké).
- `phone_source ∈ seo/ads/direct/...` (dim engine, par numéro appelé).
- Connecteur Twenty natif pousse score + timeline + utmSource.

## Demande
Quand le connecteur pousse un prospect/event vers Twenty, calculer et pousser une
**source d'acquisition normalisée** (`acquisition_source` : `google_ads` si gclid
ou phone_source=ads ; `organic_seo` si referrer Google sans gclid ; `direct` ;
etc.) dans un champ/propriété Twenty lisible et filtrable. Définir la règle de
priorité (gclid > phone_source > referrer > utm). Test E2E sur le workspace REPLAY.

⚠️ Le connecteur Twenty est cross-app sensible — coordonner avec le contrat tunnel
(CONTRATS-TUNNEL §4c). Voir [[project_tunnel_connecteur_twenty_natif_design_b]].
