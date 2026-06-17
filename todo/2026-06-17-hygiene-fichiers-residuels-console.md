# Hygiène : fichiers résiduels committés dans console/ (backup + doublons morts)

> **Sévérité** : 🔵 P3
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : ARCHIVER/SUPPRIMER (code mort) — rapide et safe
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié)

Trois résidus committés dans `console/src/` qui n'ont aucune raison d'y être et
brouillent la lecture du code réel.

### 1. Fichier de sauvegarde committé

`console/src/lib/api.ts.backup` (10.8 KB) — copie de l'ancien client API
committée. Aucun import (c'est un `.backup`). À **supprimer** (l'historique git
fait le backup, pas un fichier `.backup` dans le repo).

### 2. Doublon mort des composants assistant

`console/src/components/explore/AssistantButton.tsx` +
`console/src/components/explore/AssistantPanel.tsx` — **zéro référence**
(le composant assistant réellement monté est `components/Assistant/*`, cf
`$workspaceId.tsx:628-629`). Vérifié : aucun import de
`explore/AssistantButton` / `explore/AssistantPanel` ailleurs que les fichiers
eux-mêmes.

⚠️ Bonus : ces fichiers morts contiennent des **libellés en anglais**
(« Close assistant », « Ask AI to create a report » —
`explore/AssistantButton.tsx:13`), ce qui violerait la règle français-only
s'ils étaient remontés par erreur. À **supprimer** (sous réserve de l'arbitrage
global de l'assistant IA — cf ticket dédié ; si l'assistant est débranché,
supprimer aussi `components/Assistant/*`).

### 3. Client bridge legacy résiduel

`console/src/veridian/api.ts` (`fetchScore`, `fetchDashboard`, `fetchCalls`,
`fetchShadowMarketing`, ancien VoIP `saveCredential`/`fetchPhoneNumbers`…)
n'est consommé QUE par `veridian/_archive/` et `veridian/_optional-features/`
(+ 2 helpers résiduels). Le VoIP/GSC **live** passe par les NOUVEAUX clients
natifs `veridian/settings-panels/voip-api.ts` et `veridian/gsc/api.ts`.

Deux générations de clients VoIP coexistent ; l'ancien est résiduel. À
**confirmer mort puis archiver** sous `_archive/` (ou supprimer si plus aucune
référence vivante après le débranchement des `_optional-features/`).

## Demande précise

1. `git rm console/src/lib/api.ts.backup`.
2. Supprimer `console/src/components/explore/AssistantButton.tsx` +
   `AssistantPanel.tsx` (après confirmation zéro import — déjà vérifié).
3. Tracer les imports vivants de `console/src/veridian/api.ts` ; s'il ne
   reste que `_archive/` + `_optional-features/`, le ranger sous `_archive/`.

Action **rapide et safe** (suppression de code mort non importé, réversible via
git). Aucun impact runtime.

## Impact

Code mort + fichiers backup = bruit qui fait perdre du temps (un agent lit le
mauvais composant assistant, le mauvais client VoIP) et risque de fausse piste.
Les libellés EN dans le doublon mort sont un piège régression français-only.

## Liens

- Arbitrage assistant IA : `2026-06-17-arbitrer-assistant-ia-hors-scope.md`
