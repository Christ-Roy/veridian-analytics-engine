# Désalignement de versioning SDK / App / bundle baké → bandeau « SDK obsolète » à tort en prod

> **Sévérité** : 🟡 P1 (latent prod — faux positif visible client, pas un crash)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-28
> **Demandé par** : lead lot B5 (chasse démo nationale, ticket `TICKET-funnel-ab-segmente-demo-nationale.md` §B5 / R7bis)

## Contexte

Le composant `console/src/components/dashboard/SdkVersionWarning.tsx` compare le
**major** du `sdk_version` que portent les events trackés au **major** de
l'app (`__APP_VERSION__`, define Vite). S'il n'y a **aucun** event dont le major
matche, il affiche un bandeau jaune *« SDK obsolète détecté (X → Y) — Mettre à
jour le SDK »*.

Le lot B5 a tué le symptôme **côté démo** (data mockée semver + gate `isDemo`).
Mais le désalignement de versions sous-jacent reste un **vrai bug latent prod** :
un client réel servant un tracker plus ancien verra le bandeau alors qu'il n'a
rien à faire — ça contredit le pitch et génère du support inutile.

## Les versions constatées (2026-06-28, branche staging)

| Source | Valeur | Rôle |
|---|---|---|
| `api/src/version.ts` → `APP_VERSION` | **`12.0.0`** | **Source de vérité.** Lue au build par la console (`__APP_VERSION__`) ET par le SDK (`__SDK_VERSION__`). |
| `sdk/package.json` → `version` | **`10.0.0`** | Jamais bumpée pour suivre `APP_VERSION` (drift). |
| Bundle tracker baké servi en prod | **`6.1.0`** (constaté ticket B5) | Build SDK figé à l'époque où `APP_VERSION` valait 6.x → `__SDK_VERSION__` gelé à 6.1.0. |
| `sdk/src/core/session*.test.ts` | asserts `5.0.0` / `6.0.0` | Tests SDK eux-mêmes désalignés (encore plus vieux). |

## Mécanique du bug

- `sdk/rollup.config.js` lit `APP_VERSION` dans `api/src/version.ts` au build et
  l'injecte comme `__SDK_VERSION__` → **en théorie** un SDK fraîchement rebuild
  + une console fraîchement déployée portent le même major, pas de bandeau.
- **En pratique** : le tracker `.js` servi aux clients réels est un **bundle
  baké figé** (`6.1.0`) — il n'a pas été rebuild quand `APP_VERSION` est passé à
  12. La console, elle, a été redéployée (donc `__APP_VERSION__ = 12`).
  → `getMajorVersion('6.1.0') = 6 ≠ 12` → **bandeau affiché à tort** pour tout
  client servant ce tracker.
- `sdk/package.json` à `10.0.0` ajoute du bruit : la version npm du package ne
  reflète ni la source de vérité (12) ni le bundle réellement servi (6.1.0).

C'est donc un **bug de pipeline de release**, pas un bug de comparaison : la
logique du composant est correcte, ce sont les artefacts qui ne sont pas
réalignés ni re-servis.

## Impact

- **Faux positif visible client** : tout workspace réel dont le snippet sert le
  tracker baké < major 12 voit le bandeau « SDK obsolète » au chargement du
  dashboard, alors qu'aucune action n'est attendue de lui.
- Contredit le positionnement « stack moderne ».
- Le gate `isDemo` (lot B5) masque le symptôme **uniquement en démo** — la prod
  réelle reste exposée.

## Travail attendu (à arbitrer / planifier — NE PAS traité dans B5)

1. **Réaligner la source unique** : décider la version cible (probablement
   garder `APP_VERSION = 12.0.0` comme vérité) et **bumper `sdk/package.json`**
   pour qu'il suive `api/src/version.ts` (idéalement script qui dérive
   `package.json.version` de `version.ts`, plus de double saisie).
2. **Rebuild + re-servir le tracker** : régénérer le bundle SDK depuis la source
   de vérité (→ `__SDK_VERSION__ = 12.0.0`) et le pousser comme tracker servi en
   prod (cache-bust inclus — cf `console/src/veridian/snippet.ts`). Tant que le
   bundle baké reste à 6.1.0, le bandeau continuera de tomber.
3. **Réaligner les tests SDK** (`session*.test.ts` qui assertent `5.0.0`/`6.0.0`)
   sur la source de vérité, ou les rendre dérivés de `__SDK_VERSION__`.
4. **Durcir la règle de comparaison** (optionnel, ceinture côté composant) :
   tolérer un major « inférieur d'au plus N » avant d'alerter, OU n'alerter que
   sur un major **strictement supérieur côté app récente** + un délai de grâce —
   pour éviter d'agresser un client la seconde même où on déploie une bump major.
5. **Garde-fou CI** : check qui échoue si `sdk/package.json.version` diverge du
   major de `api/src/version.ts`, pour empêcher le drift de revenir.

## Hors scope (déjà fait — lot B5)

- ✅ Seed démo (`generators.ts`, `voip-calls.ts`) écrit `sdk_version = APP_VERSION`
  (plus de `vrddemo-seed-1.0` / `voip-seed-1.0` non-semver).
- ✅ Gate `isDemo` dans `SdkVersionWarning.tsx` (ceinture démo).

Ce ticket couvre le **vrai réalignement prod**, qui est une décision de release
(rebuild + re-publication du tracker) — à planifier hors de la chasse démo.
