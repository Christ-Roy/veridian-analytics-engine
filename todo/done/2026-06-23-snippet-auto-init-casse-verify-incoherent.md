# 🔴 Snippet officiel ne s'auto-init PAS + verify incohérent (install cassée)

> **Sévérité** : 🔴 P0 — le snippet distribué aux clients ne track rien tel quel.
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23
> **Demandeur** : Robert
> **Découvert** : branchement Yoga Sculpt (yoga-sculpt.fr + app.yoga-sculpt.fr). Tout
> vérifié sur le code + la prod réelle, pas supposé.

## Résumé exécutif

La chaîne **provision → snippet → SDK → verify est INCOHÉRENTE**. Le snippet HTML que
l'engine distribue ne déclenche jamais le tracking (le SDK ne lit pas son attribut), et
l'outil `verify` exige précisément ce snippet. Résultat : un client qui colle le snippet
officiel **ne track rien**, et `verify` renvoie `snippet_missing` même quand le tracking
marche par un autre moyen. À corriger en priorité — c'est le parcours d'installation
nominal de TOUS les clients.

## Problème 1 — 🔴 Le SDK n'auto-init PAS depuis `data-workspace-id`

**Constat (vérifié code + bundle prod)** :
- `admin-platform.service.ts → buildTrackerSnippet()` génère :
  `<script async src="…/sdk/v1/tracker.js" data-workspace-id="<ws>"></script>`
  (c'est aussi ce que renvoie `tenants.provision.snippet_html`, et ce que `verify`
  cherche dans le HTML).
- MAIS `sdk/src/index.ts` (l.79-80) ne s'auto-initialise QUE depuis un objet global :
  ```js
  if (typeof window !== 'undefined' && window.StaminadsConfig) {
    sdk.init(window.StaminadsConfig);
  }
  ```
  Le bundle livré (`/sdk/v1/tracker.js`) contient `StaminadsConfig` (×3) et **ZÉRO**
  `data-workspace-id` / `currentScript` / `dataset.workspaceId` (vérifié par grep sur
  le bundle prod téléchargé).

**Conséquence** : le snippet officiel charge le bundle mais **n'appelle jamais `init()`**
→ aucun event émis. Le snippet est **mort à la livraison**. (C'est pour ça que sur Yoga
Sculpt j'ai dû initialiser le SDK manuellement en JS — `sdk.init({workspace_id, endpoint,
crossDomains, adClickIds})` depuis un composant — au lieu d'utiliser le snippet.)

**Direction de correction (au choix de l'agent, recommandation en gras)** :
- **(A, recommandé) Faire lire le DOM au SDK** : dans `index.ts`, si pas de
  `window.StaminadsConfig`, lire `document.currentScript?.dataset` (workspaceId,
  endpoint optionnel, crossDomains optionnel via `data-cross-domains="a,b"`,
  adClickIds…) et appeler `sdk.init()` avec. C'est le comportement que 100% des gens
  attendent d'un snippet `data-*`. Garder `StaminadsConfig` en plus (compat).
- (B) Changer `buildTrackerSnippet` pour générer le double snippet :
  `<script>window.StaminadsConfig={workspace_id:"<ws>",endpoint:"…"}</script>` +
  `<script async src="…/sdk/v1/tracker.js"></script>`. Marche, mais 2 balises, et
  `data-*` reste trompeur (présent mais ignoré) → préférer (A).

→ Quel que soit le choix, **provision, SDK et verify doivent s'accorder** sur UN seul
mécanisme. Aujourd'hui ils en supposent deux différents.

## Problème 2 — 🟠 `verify` (snippet probe) ne voit pas une init JS dynamique

**Constat** : `verify --site-url` (`probeSnippet` → `auditSnippetHtml`) fait un
`fetch(siteUrl)` server-side et cherche une `<script data-workspace-id / tracker.js>`
dans le **HTML statique**. Sur Yoga Sculpt, le tracker est initialisé via un composant
React qui injecte le script + appelle `init()` côté client → **rien dans le HTML
server-rendered** → verdict `snippet_missing` ALORS QUE l'ingestion réelle marche
(`ingestion.ok:true`, `real_tracking.live:true`, goals stockés et requêtables —
vérifié en prod le 2026-06-23).

**Conséquence** : faux négatif. `verify` ne valide que l'install "snippet statique dans
le `<head>`", pas les intégrations SPA/React/dynamiques (qui sont majoritaires côté
clients Veridian, tous en Next.js).

**Direction** : compléter `verify` avec un signal qui ne dépend pas du HTML statique :
- pondérer le verdict sur **`real_tracking.live` / sessions récentes** (si du vrai
  trafic arrive pour ce workspace, l'install marche, peu importe comment le script est
  injecté) ;
- OU rendre la probe snippet **non bloquante** (info, pas verdict) quand l'ingestion
  réelle est `live` ;
- idéalement : un mode probe qui rend la page (headless) pour voir le script injecté
  par JS — plus lourd, à arbitrer.
  Verdict cible : `ok` quand ingestion OK **et** (snippet présent **OU** trafic réel live).

## Problème 3 — 🟡 Cohérence du contrat snippet (doc + provision + skill)

Une fois (A) tranché : mettre à jour `buildTrackerSnippet`, la doc, et le skill
`analytics-provision` pour que le snippet documenté soit RÉELLEMENT auto-initialisant,
et préciser comment passer `crossDomains` (essentiel pour les tunnels multi-domaines,
ex. Yoga Sculpt vitrine↔app : `data-cross-domains="app.yoga-sculpt.fr"`). Aujourd'hui le
snippet canonique ne permet pas de configurer le cross-domain → impossible de tracker un
tunnel cross-domaine via le snippet seul (encore une raison de l'init JS manuelle).

## Impact si non corrigé

Tout client qui suit la procédure nominale (coller le snippet) **croit tracker et ne
track rien**, et `verify` ne lèvera pas l'alerte de la bonne manière. Pour Yoga Sculpt
c'est contourné (init JS manuelle + cross-domain), mais c'est du code custom par site au
lieu d'un snippet standard — non scalable.

## Note
Sujet distinct du ticket `2026-06-23-reporting-acquisition-visiteur-unique-sources-funnel.md`
(celui-ci = install/snippet/verify ; l'autre = visiteur unique + sources + funnel).
Les deux sont sortis du même branchement Yoga Sculpt.
