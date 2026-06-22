# 🟡 Restructurer le skill analytics-provision → skill `analytics` (enfant) avec index

> **Sévérité** : 🟡 P1 · **Owner** : agent engine · **Créé** : 2026-06-22 · **CLAIR**

## Demande (Robert 2026-06-22)
Le skill `analytics-provision` (déjà recâblé M2M 2026-06-20) devient le skill
**`analytics`**, enfant d'un futur parent `manage-veridian`. Il doit être un INDEX
structuré en parties :
1. **Config compte + creds** (provisioning M2M, clés, snippet) — déjà couvert.
2. **SDK** : tracking, snippet `/sdk/v1/tracker.js`, `data-workspace-id`, identité
   (setUserId/identify), routes `POST /api/track`.
3. **Ads S2S** : `ads.conversions` (lecture livrée) → upload Google Ads (cf ticket
   dédié).
4. **Intégrations sur-mesure** : CRM (distinction Ads/SEO, tél tracké), GMB (review).

## À faire
- Renommer/restructurer le SKILL.md autour de ces 4 parties + un index en tête.
- Décider si on garde le nom `analytics-provision` (trigger connu) ou on crée
  `analytics` (à trancher : un alias ?). Le parent `manage-veridian` = PAS
  maintenant (attendre d'autres enfants).
- Lister dans l'index les 22 endpoints M2M déjà documentés + pointer les tickets
  d'intégration sur-mesure.

Base : `~/.claude/skills/analytics-provision/SKILL.md` (déjà à jour M2M).
