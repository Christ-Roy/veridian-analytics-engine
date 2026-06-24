# CLI `analytics` + skill analytics-provision : routes récentes non câblées

> **Sévérité** : 🟡 P1 (l'agent provisionneur ne peut pas piloter les features livrées)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Trouvé par** : hunt-archeo (audit propagation post-vagues)

## Constat
Le controller `admin-platform.controller.ts` expose des routes M2M livrées par les
2 vagues qui ne sont PAS câblées dans le CLI `~/bin/analytics` ni documentées dans
le skill `analytics-provision` :
- `analytics.funnel` (funnel par canal — vague 2 attribution)
- `analytics.conversionsByChannel` (conversions par canal — vague 2)
- `tracking.verify` (dry-run install — vague 1) ⚠️ déjà dans le CLI (`analytics verify`) — VÉRIFIER
- `webhooks.list/create/delete/test` (connecteur Twenty M2M)
- `ads.conversions` (conversions Ads pour upload — lié au ticket S5)

Conséquence : l'agent qui provisionne/configure un client ne peut pas piloter ces
capacités en S2S via le CLI — il doit taper du `curl raw` (ce que le CLI était censé
éviter). Incohérence "surface API ≠ surface CLI/skill".

## Correctif
Ajouter au CLI `~/.claude/skills/analytics-provision/bin/analytics` les commandes
manquantes (funnel, conversions, webhooks:*, ads:conversions) + documenter dans le
SKILL.md. Vérifier que `analytics verify` (tracking.verify) est bien là.
NB : le skill est HORS-REPO (`~/.claude/skills/`), donc ce travail se fait côté skill,
pas dans le repo engine. Lié au ticket `skill-analytics-restructurer-index` (le câblage
CLI fait partie de la restructuration du skill).

## Impact
L'agent provisionneur (et le futur Hub) ne peuvent pas exploiter funnel/conversions/
webhooks/ads en S2S → la promesse "tout pilotable M2M par l'IA" est incomplète.
