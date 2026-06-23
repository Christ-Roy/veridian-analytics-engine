# Pre-push husky ne lance pas tsc build complet → erreurs TS passent en CI

> **Sévérité** : 🟡 P1 (gate qualité troué)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17 (team-lead, sprint GIGA vague C)

## Constat

Pendant le port natif VoIP (2026-06-17), le pre-push husky de l'agent voip est
passé ALL GREEN en local, mais la CI staging a échoué avec **8 erreurs TypeScript
dans src/voip/** que le pre-push n'a PAS attrapées :
- `zod` importé (voip.service.ts:8, voip.providers.ts:17) absent du package.json
  → `Cannot find module 'zod'` au `npm ci` propre de la CI.
- TS1272 (import type manquant) sur voip.dto.ts lignes 29/47/60/79/104.
- TS7006 (param `i` implicit any) voip.service.ts:94.

La CI fait `tsc -p tsconfig.build.json --noEmit` sur l'API → attrape tout. Le
pre-push husky, lui, ne lance visiblement PAS ce tsc build complet sur api/
(ou le lance sur un subset / tsconfig différent / scope bridge seulement).

## Impact

Un agent peut pusher un code qui casse la CI alors que son pre-push est vert →
perte de temps (CI rouge, re-fix, re-push), et faux sentiment de sécurité.
C'est un pendant du piège memory `feedback_agent_traps_2026-05-25` #1 (dep sans
lockfile) : le gate local devrait l'attraper.

## À faire

1. Ajouter au pre-push husky une étape `tsc -p api/tsconfig.build.json --noEmit`
   (le MÊME que la CI) sur le périmètre API, en plus de ce qui existe.
2. Vérifier que `npm ci` propre (pas `npm install`) est ce qui valide les deps
   — ou au minimum un check que tout import non-relatif résout dans package.json.
3. Idempotent / rapide : ne lancer le tsc build que si des fichiers .ts de api/
   sont dans le diff pushé.

## Note

Trouvé en orchestration team-lead. Le fix voip lui-même est traité dans le ticket
port-natif-voip. Ce ticket-ci = durcir le GATE pour que ça ne se reproduise pas.
