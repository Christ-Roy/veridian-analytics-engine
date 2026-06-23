# Aligner les presets de dates entre date-utils front et back

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme
`api/src/analytics/lib/date-utils.ts` (back) et `console/src/lib/date-utils.ts`
(front) réimplémentent le même catalogue de presets avec des divergences réelles :
- `this_week` : démarre LUNDI côté back, DIMANCHE côté front
- `all_time` : démarre à 2020 (back) vs date de création du workspace (front)

## Impact si non corrigé
Le back seul résout les bornes des vraies requêtes (donc les chiffres sont bons),
mais le front peut afficher un LIBELLÉ/une plage incohérents avec les données
montrées. Confusion utilisateur sur les périodes.

## Correctif proposé
Définir les bornes de presets comme source unique. Deux options : (a) le front
appelle un endpoint back qui résout les bornes, ou (b) aligner manuellement les
deux implémentations (plus simple, moins propre). Trancher pour (b) à court terme
(aligner `this_week` sur lundi + `all_time` sur 2020 partout), noter (a) comme
amélioration future.
