# UI Native Integration — Dashboard + Settings Veridian intégrés au layout staminads

> **Sévérité** : 🟡 P1
> **Owner** : agent UI-NATIVE-INTEGRATION
> **Créé** : 2026-05-23
> **Statut** : ✅ Livré

## Contexte

Avant ce sprint, 3 routes Veridian PARALLÈLES contournaient le layout
staminads natif :

- `/veridian/dashboard/:workspaceId` (file: `veridian.dashboard.$workspaceId.tsx`)
- `/veridian/settings/:workspaceId` (file: `veridian.settings.$workspaceId.tsx`)
- `/veridian/welcome/:workspaceId` (file: `veridian.welcome.$workspaceId.tsx`)

→ L'utilisateur naviguait vers une page Veridian qui n'avait pas le header
staminads (sélecteur workspace, breakcrumb, AssistantPanel, etc.).

Robert : « il faut dégager le tunnel vers l'ancienne UI, intégrer proprement
dans l'UI de base, c'est n'importe quoi. »

## Périmètre livré (cet agent)

### Job 1 — Dashboard Veridian intégré (nouvelle sous-route native)

Choix **B** : sous-route `/workspaces/:wsId/veridian` (thin wrapper TanStack
autour de `VeridianDashboardPage`).

- Fichier ajouté : `console/src/routes/_authenticated/workspaces/$workspaceId/veridian.tsx`
- Le menu nav `Veridian` dans `workspaces/$workspaceId.tsx` pointe désormais
  sur cette sous-route.
- Hérite du layout staminads (header, workspace selector, AssistantPanel,
  redirection install-sdk si workspace non actif).
- Le contenu interne reste scopé sous `.veridian-scope` (théme dark Veridian).

### Job 2 — Settings Veridian intégrées (mode `embedded`)

`VeridianSettingsPage` reçoit un prop `embedded?: boolean` :
- `embedded=true` : retire `<SettingsHeader />`, retire `min-h-screen` et
  `max-w-4xl mx-auto` (le layout hôte fournit son cadre).
- `embedded=false` (default) : comportement standalone inchangé.

La page settings native staminads (`workspaces/$workspaceId/settings.tsx`)
ajoute :
- Item `Veridian` dans la sidebar settings (entre `Install SDK` et
  `Danger zone`).
- Rend `<VeridianSettingsPage embedded />` quand `section=veridian`.
- Le schéma Zod `settingsSearchSchema` accepte `'veridian'` comme section.

### Job 3 — Suppression du tunnel

Fichiers **supprimés** :
- `console/src/routes/_authenticated/veridian.dashboard.$workspaceId.tsx`
- `console/src/routes/_authenticated/veridian.settings.$workspaceId.tsx`

Fichiers **non supprimés** (hors scope, owner = agent UI-WELCOME-NATIVE) :
- `console/src/routes/_authenticated/veridian.welcome.$workspaceId.tsx`
  → seul changement : le `onComplete()` qui redirigeait sur
  `/veridian/dashboard/$workspaceId` redirige maintenant sur
  `/workspaces/$workspaceId/veridian` (sinon 404).

### Job 4 — Tests + coverage

- `console/src/veridian/pages/__tests__/settings.test.tsx` : +2 cas
  (mode embedded, mode standalone).
- `test-coverage-map.yaml` : entrée existante settings.tsx enrichie + nouvelle
  entrée pour la sous-route native veridian.tsx + section "Veridian" dans
  settings.tsx natif.

## Coordination

L'agent **UI-WELCOME-NATIVE** tourne en parallèle et touche aussi à la nav
dans `console/src/routes/_authenticated/workspaces/$workspaceId.tsx`. Au
merge, rebase ff-only si conflit (les zones touchées sont disjointes : nous
modifions le lien `Veridian`, lui peut bouger le lien Welcome).

## Compatibilité PROD v0.5.0

Aucun endpoint API touché. Aucune migration DB. Pure réorganisation des
routes côté front. Le tracker des sites clients (snippet `staminads_*.min.js`)
n'est pas concerné — il pointe sur l'engine, pas la console.

## Diff résumé

```
console/src/routes/_authenticated/veridian.dashboard.$workspaceId.tsx        DELETED
console/src/routes/_authenticated/veridian.settings.$workspaceId.tsx          DELETED
console/src/routes/_authenticated/workspaces/$workspaceId/veridian.tsx        ADDED
console/src/routes/_authenticated/workspaces/$workspaceId/settings.tsx        MODIFIED (+section veridian)
console/src/routes/_authenticated/workspaces/$workspaceId.tsx                 MODIFIED (lien nav)
console/src/routes/_authenticated/veridian.welcome.$workspaceId.tsx           MODIFIED (redirect onComplete)
console/src/veridian/pages/settings.tsx                                       MODIFIED (+prop embedded)
console/src/veridian/pages/__tests__/settings.test.tsx                        MODIFIED (+2 tests embedded)
test-coverage-map.yaml                                                        MODIFIED (+entrée)
docs/UI-NATIVE-INTEGRATION-2026-05-23.md                                      ADDED (ce fichier)
```
