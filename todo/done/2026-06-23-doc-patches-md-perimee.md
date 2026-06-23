# Doc PATCHES.md / VERIDIAN-README.md périmée (trompeuse)

> **Sévérité** : 🔵 P3
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme
`PATCHES.md` et `VERIDIAN-README.md` (à la racine) datent du jour du fork et
décrivent une archi à 2 étages qui n'existe plus. La vraie doc vivante = git log
+ CLAUDE.md + les 5 modules natifs réels (voip, gsc, admin-platform, tunnel,
webhooks/connecteur Twenty).

## Impact si non corrigé
Un futur agent qui s'y fie repart sur une fausse compréhension de l'archi.

## Correctif proposé
Soit réécrire pour refléter les modules natifs réels, soit tagger en tête
"⚠️ HISTORIQUE — état au fork, voir CLAUDE.md pour l'archi actuelle". Le tag
suffit (effort minimal, lève le piège).
