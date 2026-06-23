# 🔵 [REVIEW] Brancher les formulaires / data brute vers le CRM

> **Sévérité** : 🔵 à cadrer · **Owner** : Robert + agent engine · **Créé** : 2026-06-22
> **Statut** : FLOU — à reviewer ensemble

## Idée (Robert 2026-06-22)
Brancher les **formulaires** et de la **data un peu brute** (champs de form,
numéro de tél, email, message) pour qu'ils remontent dans le CRM Twenty.

## État actuel (audit 2026-06-22)
- `form_submission` est un **goal staminads natif** (pas de pipeline d'ingestion
  form dédié visible côté engine). La VISION 2026-05-23 a explicitement SUPPRIMÉ
  l'ancien module forms/lead-dedup → on utilise les goals natifs.
- Donc « brancher les forms » ≠ recréer un module forms (interdit par la vision) :
  c'est plutôt **pousser les goals form_submission (avec leurs properties) vers
  Twenty** via le connecteur.

## Questions ouvertes (Robert)
1. Quels **champs** du form on pousse au CRM (email/tél/message/tous) ? RGPD ?
2. Mapping vers quels objets Twenty (Person ? Note ? champ custom) ?
3. Dédup : un même prospect qui soumet 2 fois = 1 Person mise à jour ?
4. La data « brute » va dans une Note timeline ou des champs structurés ?
5. Confirmer qu'on reste sur les **goals natifs** (pas de réintro module forms).

## Pourquoi en review
Risque de re-spécifier une feature débranchée par la vision (module forms). À
cadrer pour rester dans le natif staminads + connecteur Twenty.

## MAJ 2026-06-23 — recoupe directement 2 chantiers consolidés
Ce sujet ≠ nouveau module : c'est **pousser les goals `form_submission` (avec leurs properties)
vers Twenty via le connecteur**, ce qui est exactement le périmètre du **Niveau 4 du ticket
`2026-06-23-ui-configurable-par-workspace-branding-features-widgets.md`** (mapping goals→CRM
configurable + résolution d'identité configurable). Quand N4 est traité, ce ticket devient un
simple cas d'usage de la config générique (déclarer `form_submission` comme milestone CRM, mapper
ses champs). → Ne PAS recoder un pipeline forms ; cadrer ce ticket dans le N4. Reste à trancher
avec Robert : quels champs (RGPD), quel objet Twenty (Person/Note), dédup.
