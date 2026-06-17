# Exposer la source d'appel (`properties.source`) comme dimension analytique

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics (engine)
> **Créé** : 2026-06-17
> **Axe audit** : KPI/Dashboard — parité backend↔UI

## Constat (trou de parité prouvé par le code)

La feature commerciale centrale Veridian « 1 numéro = 1 source » (vision
2026-05-25, mémoire `project_vision_2026-05-25_provisioning_telcalls`) est
**calculée côté backend mais TOTALEMENT inexploitable côté UI**.

Le backend attribue à chaque appel une source de trafic (seo / ads / direct /
email / social / print / other) par lookup E164 → source, et l'écrit dans
l'event :

- `api/src/voip/phone-call-event.ts:54` → `properties.source = source` (la
  source attribuée, fallback `direct`).
- `api/src/voip/phone-call-event.ts:46-55` → l'event est un goal
  `goal_name='phone_call'`, poussé dans la table `goals`.
- `api/src/database/schemas.ts:634` → la table `goals` a bien
  `properties Map(String, String)`, et le MV `goals_mv`
  (`api/src/database/schemas.ts:711` + `722` `e.properties`) propage
  `properties` → **`properties['source']` est physiquement stocké et
  requêtable en ClickHouse**.

MAIS aucune `DimensionDefinition` n'expose cette donnée :

- `api/src/analytics/constants/dimensions.ts` (dict `DIMENSIONS` complet,
  448 lignes) → **aucune entrée `source` ni `properties[...]`**. Les seules
  « sources » du dict sont `utm_source`, `referrer*`, `channel*`.
- `api/src/analytics/lib/query-builder.ts` ne référence QUE les colonnes
  physiques mappées par `DIMENSIONS` — il n'a aucun chemin pour
  `properties['source']`.

Conséquence directe côté console (vérifié) :

- `console/src/components/explore/DimensionSelector.tsx:79` charge la liste
  des dimensions depuis `analytics.dimensions`
  (`console/src/lib/api.ts:117`) → la console ne propose QUE ce que le dict
  backend expose. `source` n'y est jamais → **impossible de grouper/filtrer
  les appels par source dans Explore**.
- `console/src/components/dashboard/DashboardGrid.tsx:275` et
  `console/src/components/goals/GoalDashboardDrawer.tsx:198` : l'onglet
  « Sources » utilise `utm_source`. Un `phone_call` a `utm_source` vide →
  **les appels n'apparaissent JAMAIS dans la vue Sources**, et la
  répartition appels-par-source (le KPI vendeur) n'existe nulle part.

La vision (`CLAUDE.md` analytics, scope final 2026-05-23) affirme pourtant :
« les appels apparaissent dans Live/Explore/Goals **filtrables par dimension
`source`** ». C'est faux aujourd'hui : la dimension n'existe pas.

## Impact

- Le différenciateur commercial nº2 (Calls + attribution par source) est
  borgne : le client configure ses numéros → sources dans Settings VoIP
  (`voip-panel.tsx`) mais ne peut **jamais voir le résultat** (« combien
  d'appels viennent du SEO vs des Ads ? »).
- Donnée déjà en base, déjà payée en stockage et en sync — gâchée faute de
  3 lignes de dimension.

## Demande précise (voie propre, conforme à la vision — zéro page custom)

1. **Backend** — ajouter une dimension dans
   `api/src/analytics/constants/dimensions.ts` qui pointe vers la clé Map :

   ```ts
   phone_source: {
     name: 'phone_source',
     column: "properties['source']",
     type: 'string',
     category: 'Téléphonie',
     tables: ['goals'],
   },
   ```

   Vérifier que `query-builder.ts` gère correctement une `column` de la forme
   `properties['source']` dans le `GROUP BY` / `SELECT` / `WHERE` (syntaxe
   d'accès Map ClickHouse). Si le builder suppose des identifiants simples,
   l'étendre proprement (tests `query-builder.spec.ts` + `filter-builder.spec.ts`).
   Idéalement exposer aussi `phone_direction` (`properties['direction']`) et
   `phone_status` (`properties['status']`) tant qu'on y est — même mécanisme,
   même valeur produit.

2. **UI** — RIEN à coder de spécifique : la dimension apparaît
   automatiquement dans le `DimensionSelector` d'Explore (catégorie
   « Téléphonie ») et est utilisable comme breakdown/filtre sur la table
   `goals`. C'est exactement le mécanisme natif voulu par Robert (extension
   via dimension staminads, pas de sous-route Veridian).

   Optionnel (si Robert valide) : un onglet de breakdown « Sources d'appel »
   dans le `GoalDashboardDrawer` du goal `phone_call`, dimension
   `phone_source` — reste dans le natif (drawer goal existant), pas de page
   dédiée.

## Preuve résumée

| Élément | Fichier:ligne | Statut |
|---|---|---|
| source écrite dans l'event | `api/src/voip/phone-call-event.ts:54` | ✅ calculé |
| properties stocké/propagé en CH | `schemas.ts:634,722` | ✅ requêtable |
| dimension `source` dans le dict | `dimensions.ts` (tout le fichier) | ❌ absente |
| UI tire les dims du dict backend | `DimensionSelector.tsx:79` + `api.ts:117` | ❌ donc invisible |
| « Sources » UI = utm_source | `DashboardGrid.tsx:275` | ❌ pas la source tél |
