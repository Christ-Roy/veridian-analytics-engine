# 🟡 Restructurer le skill `analytics-provision` → skill `analytics` (index 4 parties)

> **Sévérité** : 🟡 P1 (cap produit IA-first Robert 2026-06-22)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-22 (fusion ROADMAP-skill + skill-analytics-enfant-index — c'étaient 2 méta-docs du même sujet)

## Demande (Robert 2026-06-22)
Le skill `analytics-provision` (déjà recâblé M2M 2026-06-20) devient le skill **`analytics`**,
futur enfant d'un parent `manage-veridian` (le parent viendra quand 2-3 enfants existeront —
PAS maintenant). Le skill doit être un **INDEX** structuré en 4 parties :

1. **Config compte + creds** (provisioning M2M, clés, snippet) — déjà couvert.
2. **SDK** : tracking, snippet `/sdk/v1/tracker.js`, `data-workspace-id`, identité
   (`setUserId`/`identify`), `POST /api/track`.
3. **Ads S2S** : `ads.conversions` (lecture livrée) → upload Google Ads (cf chantier
   `2026-06-23-CHANTIER-attribution-bout-en-bout.md` S5).
4. **Intégrations sur-mesure** : CRM (distinction Ads/SEO, tél tracké — chantier attribution S4),
   GMB (`review/`), config UI par workspace (`ui-configurable-par-workspace`).

## À faire
- Restructurer le `SKILL.md` autour de ces 4 parties + un index en tête.
- Lister dans l'index les **22 endpoints M2M** déjà livrés (`/api/admin/platform/*`) et pointer
  vers les chantiers d'intégration (attribution, ui-configurable).
- Décider du nom : garder `analytics-provision` (trigger connu) ou créer `analytics` (alias ?).
  Le parent `manage-veridian` = PAS maintenant.
- Tenir le skill VIVANT au fil des vagues (chaque nouvel endpoint M2M = MAJ de l'index).

## Principe directeur (Robert)
**Automatiser ce qui peut l'être, sur-mesure pilotable IA pour ce qui doit l'être**
(poser les creds = sur-mesure via API M2M). Le skill est la doc/orchestration de cette surface.

Base : `~/.claude/skills/analytics-provision/SKILL.md` (déjà à jour M2M).

## Tickets absorbés (supprimés)
`2026-06-22-ROADMAP-skill-analytics-et-integrations-surmesure.md` (index → ses sous-tickets
attribution sont fusionnés dans le CHANTIER attribution), `2026-06-22-skill-analytics-enfant-index.md`.
