> ## 📌 AVANCEMENT 2026-06-29 (lead) — BACKEND LIVRÉ EN PROD, RESTE LE FRONT
>
> Chantier backend générique livré (main=9204661, vague ultracode) :
> - ✅ **A2** dimension `variant` (properties['variant']) — filtrer/segmenter par variante
> - ✅ **A1** `segment_by` funnel multi-séries A/B/C en 1 requête + SEGMENT_MAX=12 + rétro-compat
> - ✅ **A3-value** valeur € (sumIf goal_value) par étape de funnel
> - ✅ **WC** validation widget×table au persist (plus de widget custom cassé)
> - ✅ **fix order** (bug "Pages les plus consultées" = ORDER BY metric non sélectionnée → 500, réglé)
> - ✅ **B5** bandeau "SDK obsolète" tué en démo (+ ticket P1 versioning pipeline déposé)
>
> **RESTE (front + data, lot 1 du ticket ci-dessous)** :
> - B1/B2/B4 : onglet Tunnel dédié + sélecteur variante + 3 entonnoirs A/B/C côte à côte + séquence pré-remplie (le backend segment_by est PRÊT à consommer)
> - B3 : rendu entonnoir premium (trapèze echarts)
> - B6/B7 : géo FR + white-label (B7 = décision déploiement instance non-demo)
> - **Data-0** : seeder les goals ASD avec properties['variant']='A/B/C' + goal_name FR + sdk_version semver (cf scratchpad PRE-REQUIS-DATA-VARIANT-ASD.md) — SINON le funnel A/B sort vide.
>
> Le backend ne bloque plus rien. Prochaine vague = le front (mode UI team-orchestration).
>
---
<!--
TICKET généré 2026-06-28 par audit multi-agent (workflow ultracode) du repo veridian-analytics-engine.
Déclencheur : démo Veridian Analytics sur-mesure pour ASD (funnel A/B onboarding). Pour l'équipe dédiée.
Méthode : carto API+console+démo → analyse de gap backend/frontend → vérif adversariale (real_gap vs exists_unexposed vs faux positif) → synthèse.
-->

# GIGA-TICKET — Funnel A/B segmenté + démo "national FR" pour Veridian Analytics Engine

## Résumé exécutif

L'engine analytics sait calculer un funnel (`analytics.funnel` / `windowFunnel` ClickHouse) mais **uniquement en mono-série, sans segmentation par dimension**, et la console n'a **ni onglet Tunnel dédié, ni comparaison A/B/C, ni vue géographique nationale**. Déclencheur : une démo client (e-commerce croquettes en abonnement, marché 100 % France) dont LA promesse de vente est un *entonnoir d'onboarding comparé variante A vs B vs C, à l'échelle nationale*. En l'état, c'est infaisable proprement : il faut orchestrer N appels et recoller à la main côté front, sur une UI vide-au-démarrage qui affiche en plus un bandeau "SDK obsolète" parasite et une carte du monde hors-sujet. Ce ticket comble les trous backend (segmentation funnel, dimension de propriété de goal, valeur/série temporelle) et frontend (onglet Tunnel pré-rempli, sélecteur de variante, rendu entonnoir, géo FR, polish démo) pour rendre la démo présentable puis crédible.

---

## Contexte & objectif produit

Veridian vend son moteur analytics en marque blanche à des PME. L'argument différenciant pitché au prochain client : **"on construit votre A/B testing d'onboarding sur-mesure"** — montrer, dans une console à *leur* marque, l'entonnoir `compte créé → onboarding complété → adresse renseignée → 1ère commande`, décliné par variante d'expérience (A/B/C), avec taux de complétion par étape par variante, et une lecture **nationale française** (régions/départements), pas une mappemonde.

Besoin concret, par ordre d'importance commerciale :

1. **Funnel comparé A/B/C** : une vue où les 3 entonnoirs de variantes s'affichent côte à côte, taux de complétion étape par étape. C'est le cœur du pitch. Sans ça, le client voit un tunnel générique et la valeur "quelle variante convertit le mieux" est invisible.
2. **Démo immédiatement présentable** : ouvrir la console et voir un entonnoir rempli en 1 clic (pas un Select vide à configurer devant le client), sans bandeaux/erreurs parasites, à la marque du client.
3. **Récit géographique national** : répartition des conversions par région FR, pas une carte du monde avec un seul point sur la France.

Le workspace de démo existe déjà et contient ~15 700 sessions mockées (onboarding A/B taggé). Le moteur a la donnée ; il lui manque les surfaces de requête et d'affichage.

---

## État actuel — ce qui EXISTE déjà (ne pas refaire)

### Backend

- **`analytics.funnel`** : endpoint POST fonctionnel.
  - DTO `FunnelQueryDto` (`api/src/analytics/dto/funnel-query.dto.ts`) : `{ workspace_id, steps[2..8], dateRange, filters?, timezone?, unit?, window_seconds? }`.
  - `FunnelStepDto` porte déjà un champ **`label` optionnel** (rendu via `analytics.service.ts:558` → `label: s.label || s.goal_name`).
  - Builder SQL `api/src/analytics/lib/funnel-builder.ts` : un seul `windowFunnel` agrégé, `countIf(level >= N) AS sN`, fenêtre = `window_seconds` (par défaut plage entière), borné **2..8 étapes**, unité `session_id` ou `visitor_id`.
  - Réponse `FunnelResponse` : `{ entered, overall_conversion, steps[] }` (mono-série plate).
  - **`filters: FilterDto[]` accepte N'IMPORTE quelle dimension** déclarée dans `DIMENSIONS` — le moteur sait déjà filtrer un funnel par n'importe quelle colonne whitelistée.
- **Miroir M2M** : `admin-platform.service.ts:489` → `return this.analyticsService.funnel(dto)` (strictement identique).
- **Registre de dimensions** (`api/src/analytics/constants/dimensions.ts`) : `channel`, `utm_*`, `device`, `geo` (`country`, **`region`**, `city`), **`stm_1..stm_10`** (colonnes custom sur table `goals`), `goal_name`. Les `phone_*` prouvent que le pattern `properties['clé']` (Map accessor) fonctionne déjà dans le filter/query builder.
- **Filter/query builder générique** : `filter-builder.ts` (résout via `DIMENSIONS[dim]`), `query-builder.ts` gère `groupBy`/`totalsGroupBy` et l'aliasing back-to-name des accessors Map — **mais ce mécanisme n'est PAS branché sur le chemin funnel**.
- **Métriques de valeur** : `sum/avg/median_goal_value` existent (`metrics.ts:156-170`) pour le query-builder/cartes Objectifs — **jamais câblées dans le funnel**.
- **Table `goals`** (`api/src/database/schemas.ts`) : `properties Map(String,String)`, `goal_value Float32`, `goal_timestamp DateTime64(3)`, `region String` — la donnée value/temps/région/propriété est physiquement là.
- **Seed démo** (`api/src/demo/`) : 100 % hardcodé Apple e-commerce (`add_to_cart/checkout_start/purchase`, 200k sessions/90j, `demo.generate()` sans body). **Non réutilisable pour ce client** — la donnée de démo est déjà injectée hors-seed via track API (préfixe `vrddemo_`).

### Frontend (console)

- **`FunnelPanel.tsx`** (`console/src/components/goals/`) : appelle `api.analytics.funnel` **une fois**, filtre **uniquement par `channel_group`** (state unique l.30, filtre l.80-90), rend une **stack de barres horizontales monochromes** (`bg-[var(--primary)]`, l.206-215). Démarre **vide** (`steps=[]` l.29, `<Empty>` tant que <2 étapes l.145-150, requête `enabled: steps.length>=2`).
- **Nav** (`console/src/routes/_authenticated/workspaces/$workspaceId.tsx:247-254`) : 7 entrées (Tableau de bord, En direct, Explorer, Objectifs, Filtres, Annotations, Paramètres). **Aucun onglet Tunnel.** Le `FunnelPanel` est enterré sous la grille de cartes dans `goals.tsx:378-390`.
- **White-label** : `console/src/veridian/branding.tsx` — couleur accent + logo + nom + favicon **par workspace, pleinement câblé** (M2M `setBranding`). MAIS **désactivé de force quand `IS_DEMO=true`** (garde-fou volontaire, l.62-63). `IS_DEMO` est **instance-wide** (`demo.controller.ts:44-47`), pas par workspace.
- **Géo** : `CountryMapView.tsx` + `LiveMap.tsx` = carte **monde** echarts (`world-geo.json`, seul geojson du repo). `region`/`city` sont des dimensions queryables (consultables aujourd'hui via Explorer → template "Géographie"), mais **aucun widget carte/breakdown régional FR**.
- **Mode démo** : `DemoBanner` (bandeau bleu Veridian) + `DemoFooter` + `SdkVersionWarning` (bandeau jaune "SDK obsolète").
- **echarts est déjà dans le bundle** (7 composants l'utilisent) — type `series:'funnel'` natif dispo, non utilisé.

---

## Manques à combler

Légende effort : **S** ≤ 1j · **M** ~2-4j · **L** ~1 semaine+. Priorité : **P0** = bloquant démo · **P1** = crédibilité forte · **P2** = polish/nice-to-have.

### A. BACKEND

---

#### A1 — `segment_by` : segmenter le funnel par dimension en un seul call · **real_gap** · M · **P0**

**Description.** `analytics.funnel` renvoie une seule série plate. Aucun champ `segment_by`/`breakdown`/`groupBy` dans `FunnelQueryDto`, aucune structure multi-séries dans `FunnelResponse`. Le builder fait un `windowFunnel` agrégé sans `GROUP BY` sur une dimension de segmentation (le seul GROUP BY porte sur l'unité du tunnel : `session_id`/`visitor_id`).

**Pourquoi.** Le cœur du pitch = comparer A/B/C en une vue. Sans `segment_by`, on est forcé à N appels orchestrés + recollage front, sans aucune surface (UI ni API) qui le fasse. C'est LE trou central. *(Note : les "funnels nommés persistés" `funnels.set/get/run` supposés par certains outils CLI N'EXISTENT PAS dans le code — 0 hit grep. Seul `analytics.funnel` ad-hoc existe.)*

**Fichiers.**
- `api/src/analytics/dto/funnel-query.dto.ts`
- `api/src/analytics/lib/funnel-builder.ts`
- `api/src/analytics/analytics.service.ts` (méthode `funnel` ~l.497-577)
- `api/src/analytics/analytics.controller.ts` + miroir `api/src/admin-platform/admin-platform.service.ts:489`

**Proposition technique.**
1. DTO : ajouter `segment_by?: string` (nom de dimension, validé en aval par `DIMENSIONS`) + une limite dure de cardinalité (`SEGMENT_MAX = 12` séries, throw au-delà pour protéger ClickHouse).
2. Builder : quand `segment_by` est fourni, ajouter la colonne de segmentation au `SELECT` ET au `GROUP BY` (en plus de l'unité). ClickHouse `windowFunnel` accepte trivialement un `GROUP BY <dim>` supplémentaire → une ligne de `countIf(level>=i)` **par valeur de segment**.
3. Réponse : introduire `FunnelSegmentedResponse { segment_by, segments: { key: string; label: string; entered; overall_conversion; steps[] }[] }`. **Ne pas casser** le contrat mono-série existant : la réponse reste plate si `segment_by` absent (ou wrapper rétro-compatible).
4. Service : une seule requête, dispatch des lignes par clé de segment → N séries.
5. Câbler à l'identique sur le miroir M2M (aucune logique en plus).

**Critère.** `POST analytics.funnel` avec `segment_by:'<dim variante>'` renvoie les N entonnoirs en **une requête ClickHouse**.

---

#### A2 — Dimension générique `goal_property` / `variant` (filtrer/segmenter par `properties['variant']`) · **real_gap léger** (plomberie déjà là) · S · **P0**

**Description.** Le filtrage funnel passe par `buildFilters` → `DIMENSIONS[filter.dimension]`, qui **throw "Unknown dimension"** pour toute clé non déclarée (`filter-builder.ts:25-28`). `DIMENSIONS` n'expose `properties['…']` que pour `phone_source/phone_direction/phone_status`. **Aucune dimension générique** pour `properties['variant']` ou toute clé arbitraire de goal.

**Pourquoi.** La variante d'onboarding est une propriété naturelle du goal (`properties['variant']='A'`). Sans cette dimension, impossible de dire "funnel filtré/segmenté sur variant=A" sans hack (polluer un slot `stm_*` à l'ingestion, ou dupliquer les `goal_name` par variante → casse la lecture native des Objectifs). C'est le fix **le plus rentable** et il débloque A1 et tout le front A/B.

**Fichiers.**
- `api/src/analytics/constants/dimensions.ts` (modèle = `phone_*`, l.472-492)
- (lecture seule, pour vérifier que rien d'autre ne bouge) `filter-builder.ts`, `query-builder.ts:271-284`, `schemas.ts:390/673`

**Proposition technique.** Ajouter une (ou deux) entrée(s) dans `DIMENSIONS`, copie conforme du pattern `phone_*` :
```ts
variant: { column: "properties['variant']", type: 'string', tables: ['goals'] },
// optionnel, générique : goal_property piloté par un paramètre — sinon une dim par clé connue
```
Zéro migration, zéro changement de query/filter builder (l'aliasing Map et `col = dim.column` gèrent déjà tout), zéro changement DTO (`FilterDto.dimension` est un `IsString` libre).

**Limite à connaître.** ClickHouse n'a pas de skip-index sur la clé d'un `Map` → filtrer sur `properties['variant']` scanne. Acceptable à l'échelle démo. **Pré-requis data** : les goals doivent réellement porter `properties['variant']` (le tracker/track endpoint doit l'écrire) — orthogonal au gap backend, voir lot data.

**Critère.** `filters:[{dimension:'variant',operator:'equals',values:['A']}]` passe, et `segment_by:'variant'` (A1) sort A/B/C en un call.

---

#### A3 — Valeur (€) et série temporelle par étape de funnel · **real_gap** (value cheap, timeseries plus lourde) · S+M · **P1/P2**

**Description.** `FunnelStepResult` ne porte que `count` + taux ; le SQL ne fait que `countIf(level>=N)`. **Pas de `sumIf(goal_value)`** (alors que `goal_value Float32` est déjà lu depuis la table `goals`), **pas de bucket temporel** (`window_seconds` est la fenêtre windowFunnel, PAS un découpage de série).

**Pourquoi.** Une démo A/B "pilotable" montre la valeur générée par variante (1ères commandes) et l'évolution du taux dans le temps. Snapshot statique sinon.

**Fichiers.** `funnel-query.dto.ts` (`FunnelStepResult`), `funnel-builder.ts:65-91`.

**Proposition technique.**
- **Valeur (S, P1)** : ajouter `sumIf(goal_value, level>=N) AS vN` dans la sous-requête + champ `value` dans `FunnelStepResult`. ~1-liner SQL + 1 champ DTO. La donnée est déjà dans la table.
- **Série temporelle (M, P2)** : réécrire en `GROUP BY toStartOf<granularity>` ou boucler le funnel sur N sous-plages. Plus lourd, nice-to-have post-démo.

**Critère.** `FunnelStepResult.value` renseigné ; (P2) endpoint retourne le taux par bucket.

---

#### A4 — Notion native d'expérience A/B (Experiment / arms / uplift / significativité) · **real_gap total** · L · **P2**

**Description.** Aucun concept `experiment/variant/cohort/ab_test` métier dans `api/src` (les seuls hits `variant` = bits UUID RFC4122). Pas de table Experiment (nom, hypothèse, dates, arms, allocation), pas d'endpoint listant les variantes d'un test, **pas de calcul d'uplift/p-value/confiance**.

**Pourquoi.** Un outil A/B crédible affiche "variante gagnante, uplift %, signal de confiance". **MAIS ce n'est PAS bloquant pour la démo** : une fois A1+A2 livrés, le "gagnant + uplift" se calcule **côté front** à partir des N séries. La table Experiment + significativité est le différenciateur "pro" à arbitrer vs effort.

**Fichiers.** Nouveau module `api/src/experiments/` (à créer) ; migration ClickHouse/PG.

**Proposition.** Hors lot 1. Si retenu plus tard : entité Experiment (PG), endpoint `experiments.*`, calcul uplift + intervalle de confiance (z-test deux proportions) côté service. Effort L.

---

### B. FRONTEND / UX

---

#### B1 — Comparaison A/B/C des funnels côté UI · **real_gap (UI only, backend prêt)** · M (+ pré-requis data) · **P0**

**Description.** `FunnelPanel.tsx` ne câble que `channel_group` et ne rend qu'UNE séquence. Aucun sélecteur de variante, aucun rendu côte à côte. Le moteur sait filtrer par n'importe quelle dimension → **le trou est 100 % frontend.**

**Pourquoi.** C'est la promesse de la démo. Sans ça, on ne montre qu'un entonnoir à la fois.

**Fichiers.** `console/src/components/goals/FunnelPanel.tsx`, `console/src/routes/_authenticated/workspaces/$workspaceId/goals.tsx`.

**Proposition technique.**
1. Ajouter un Select "Variante" (dimension `variant` une fois A2 livré, ou `stm_2` en fallback) à côté du Select canal.
2. Mode comparaison : soit consommer la réponse multi-séries de A1 (recommandé), soit (fallback sans A1) lancer N `useQuery` (A/B/C) et rendre N colonnes d'entonnoir en parallèle.
3. **Pré-requis data (bloquant) :** la donnée onboarding doit être taggée par variante sur une dimension filtrable (`properties['variant']` via A2, OU `stm_2='A/B/C'`). Sinon les 3 entonnoirs s'affichent vides.

**Critère.** Sélecteur "Variante" → 3 entonnoirs A/B/C côte à côte avec taux par étape.

---

#### B2 — Onglet/écran "Tunnel" dédié dans la nav · **real_gap (frontend)** · M · **P0**

**Description.** Aucun onglet Tunnel/Funnel ; pas de route `funnel.tsx`/`tunnel.tsx`. L'entonnoir est enterré sous la grille de cartes Objectifs, invisible sans scroller.

**Pourquoi.** En démo : ouvrir Objectifs → scroller → tomber sur un entonnoir vide à configurer devant le client = zéro effet "waouh". Un onglet dédié avec funnel pré-rempli rend la démo immédiate.

**Fichiers.** `console/src/routes/_authenticated/workspaces/$workspaceId.tsx` (nav desktop l.247-254 + mobile l.491-497), nouvelle route `…/$workspaceId/funnel.tsx`, `goals.tsx`.

**Proposition.** Créer une route `Tunnel` montant le `FunnelPanel` enrichi (B1+B3), étapes pré-remplies (B4), en pleine page. Ajouter l'entrée nav desktop + mobile.

**Critère.** Entrée "Tunnel" dans la nav → écran funnel pré-rempli, sans scroll.

---

#### B3 — Rendu entonnoir premium (trapèze + dropoffs colorés + icônes) · **real_gap (frontend)** · S/M · **P1**

**Description.** Rendu actuel = barres horizontales monochromes, % en bout, dropoff seulement en tooltip ("X abandons"). Pas de forme d'entonnoir, pas de mise en valeur des pertes. "Dashboard interne", pas "démo qui claque".

**Pourquoi.** Pour un pitch de vente, un vrai entonnoir trapézoïdal avec dropoffs rouges entre étapes est bien plus parlant. Fort ROI commercial.

**Fichiers.** `FunnelPanel.tsx:160-219`. Toute la data nécessaire est déjà dans le contrat (`FunnelStepResult`: `count`, `conversion_from_previous/from_start`, `dropoff_from_previous` — `console/src/types/analytics.ts:132-149`). **Zéro backend.**

**Proposition.** Remplacer les barres par une **echarts `series:'funnel'`** (echarts déjà dans le bundle, aucune dépendance), OU dessiner un trapèze SVG maison avec segments de dropoff rouges entre étapes + icônes d'étape.

**Critère.** Entonnoir en trapèze, dropoffs visuellement distincts.

---

#### B4 — Séquence par défaut (entonnoir non vide à l'ouverture) · **real_gap (frontend)** · S · **P0**

**Description.** `steps=[]` au montage, `<Empty>` tant que <2 étapes, requête désactivée. Le client voit un Select vide.

**Pourquoi.** Première impression = écran à remplir à la main. À éviter en démo.

**Fichiers.** `FunnelPanel.tsx` (l.29, 145-150).

**Proposition.** `useEffect` : une fois `goalOptions` chargé ET si `steps` vide, seed avec la séquence onboarding métier (ordre : `compte créé → onboarding complété → adresse renseignée → 1ère commande`) en ne gardant que les goals réellement présents sur la période ; fallback = N premiers goals par fréquence desc. **Ne re-seeder que si vide** (ne pas écraser une sélection utilisateur).

**Critère.** Onglet Tunnel ouvert → entonnoir rempli immédiatement.

---

#### B5 — Bandeau jaune "SDK obsolète" parasite en démo · **real_gap (ALLUMÉ actuellement)** · S · **P0**

**Description.** `SdkVersionWarning.tsx` rendu **inconditionnellement** en haut du dashboard (`index.tsx:75`), sans gate `is_demo`. La data mockée porte des `sdk_version` non-semver (`vrddemo-seed-1.0`, etc.) ; `getMajorVersion()` ne matche que `/^(\d+)\./` → `null` → aucun match avec `APP_VERSION=12` → **bandeau déclenché**. Vérifié : déjà affiché sur le workspace de démo.

**Pourquoi.** Premier élément que le client voit = un signal d'erreur jaune "Mettre à jour le SDK", qui contredit le pitch "stack moderne".

**Fichiers.** `console/src/components/dashboard/SdkVersionWarning.tsx`, `…/index.tsx:75`. *(NB : divergence de versioning plus large — `APP_VERSION=12`, SDK `package.json=10`, bundle baked `6.1.0` — vrai bug latent prod, ticket séparé.)*

**Proposition.** Démo : re-seeder la data avec `sdk_version` conforme au major courant (`12.0.0`) — le plus propre, le warning ne s'affiche plus naturellement. OU gate `is_demo` dans le composant (mais masque un vrai problème produit → à coupler avec le fix versioning).

**Critère.** Dashboard de démo sans bandeau SDK.

---

#### B6 — Vue géographique nationale FR (pas carte du monde) · **exists_unexposed (data) + real_gap (rendu carte FR)** · S (data/Explore) → M (widget FR) · **P1**

**Description.** `CountryMapView`/`LiveMap` = carte **monde** (`world-geo.json`, seul geojson du repo ; echarts ne ship pas la France). Widget Countries du dashboard câblé sur `country` uniquement. MAIS `region`/`city` sont **déjà des dimensions queryables** (sessions+goals) → un breakdown FR par région est **déjà consultable dans Explorer → template "Géographie" + filtre pays=FR**, sans dev.

**Pourquoi.** Un e-commerce 100 % FR a besoin de "Île-de-France / PACA / …", pas d'une mappemonde avec un point. Les flags `geo_store_region/geo_store_city` ne pilotent que l'ingestion, aucun widget.

**Limites identifiées.** `region` est rempli depuis MaxMind (`geo.service.ts:141`, `subdivisions[0].names.en` = texte libre anglais, pas de référentiel INSEE/département). Data démo géo pauvre (1 profil FR ~7 %, region unique). **Aucune normalisation FR, aucun endpoint "national FR".**

**Fichiers.** `console/src/components/dashboard/CountryMapView.tsx`, `LiveMap.tsx`, `DashboardGrid.tsx` (`countriesTabConfig` l.308-323), `console/src/lib/` (ajouter `france-regions-geo.json`).

**Proposition.**
- **Quick win (démo immédiate)** : re-seeder une distribution FR multi-régions crédible + masquer la carte monde du dashboard via `dashboard_layout.hidden_widgets` (M2M `setLayout`, zéro dev) + s'appuyer sur Explorer template Géographie pour le récit.
- **Vraie valeur (M, P1)** : ajouter un geojson régions FR + une variante de widget carte (réutiliser le pattern `CountryMapView`, brancher sur la dimension `region` existante). Normaliser `region` vers un référentiel FR canonique (mapping noms MaxMind → régions FR).

**Critère.** Dashboard de démo sans mappemonde ; répartition par région FR visible (Explore au minimum, widget carte FR idéalement).

---

#### B7 — White-label visible (logo/couleur/titre client) · **exists_unexposed — choix de DÉPLOIEMENT, pas du dev** · ~0 (option A) / S (option B) · **P0 (décision)**

**Description.** Le white-label par workspace (couleur, logo, nom, favicon) est **intégralement codé et câblé** (`branding.tsx:30-127`). Il est **désactivé de force quand `IS_DEMO=true`** (garde-fou volontaire). `IS_DEMO` est instance-wide. Donc sur l'instance démo publique, tout workspace voit le violet/logo Veridian. *(Le titre, lui, utilise déjà `workspace.name` même en démo : `${name} · Analytics`.)*

**Pourquoi.** La promesse "console à votre marque" est invisible si la démo tourne sur l'instance `IS_DEMO`. Le bleu Veridian jure avec la charte du client.

**Fichiers.** `console/src/veridian/branding.tsx`, `demo-banner.tsx`, `demo-footer.tsx`, `__root.tsx`, `demo.controller.ts`.

**Décision à prendre.**
> **Choix à faire** : où servir la démo client.
> - **Option A (~75 %)** : workspace réel sur **instance NON-demo** (`IS_DEMO=false`) → white-label PLEINEMENT fonctionnel + zéro bandeau/footer démo, **zéro code**. Perd l'auto-login anonyme et le badge "données démo lecture seule".
> - **Option B (~25 %)** : rendre bandeau/footer/branding white-labelables par workspace (transformer `is_demo` en flag par-workspace, exposer couleur/texte dans `publicConfig`) → garde l'auto-login démo ET la charte client, **vrai dev S**, mais touche aussi auto-login + lecture seule (risqué).
>
> **Ma reco** : Option A. Effort quasi nul, white-label natif, démarche standard pour une démo client sur-mesure.

**Critère.** La console de démo affiche logo + couleur + nom du client (pas Veridian).

---

#### B8 — Polish bandeaux/footer démo Veridian · **real_gap (frontend)** · S · **P1** *(N/A si B7=Option A)*

`DemoBanner` (gradient bleu `#1d4ed8→#3b82f6`) + `DemoFooter` (slate-900, lien veridian.site) sont rendus globalement sur `IS_DEMO`, hors charte. Si on garde l'instance démo (B7 option B), les rendre white-labelables (couleur/texte/lien par workspace). Fichiers : `console/src/veridian/demo-banner.tsx`, `demo-footer.tsx`, `__root.tsx`.

---

#### B9 — Labels FR des objectifs (pas `add_to_cart`) · **real_gap (surtout data)** · S · **P1**

**Description.** Les goals s'affichent par `goal_name` brut (`GoalCard.tsx:244`, `FunnelPanel.tsx:50-56`). Aucun dictionnaire `goal_name → libellé FR`. *(Le backend funnel sait déjà afficher un `label` propre — `FunnelStepDto.label` + `analytics.service.ts:558` — mais `FunnelPanel` ne le câble pas.)*

**Pourquoi.** Voir `add_to_cart`/`checkout_start` dans une démo croquettes casse le "sur-mesure".

**Proposition (la plus propre).** Seeder la data avec des `goal_name` métier directement lisibles (`Compte créé`, `Onboarding complété`, `Adresse renseignée`, `1ère commande` — un `goal_name` transite tel quel, espaces/accents OK). Aucune touche code. **Vérifier d'abord les `goal_name` réels du workspace de démo** (peut-être déjà propres). Alternative dev : câbler `FunnelStepDto.label` dans `FunnelPanel.tsx:76` + mapping front + même mapping dans `GoalCard`.

**Fichiers.** Data (seed/track) ; sinon `GoalCard.tsx`, `FunnelPanel.tsx`.

---

#### B10 — Colonne "App" non pertinente (mono-app) · **real_gap (cosmétique)** · S · **P2**

`ConversionsByChannelPanel.tsx:63-67` affiche une colonne "App" codée en dur (groupée par `channel_group × properties['app']`). Pour un mono-site sans `properties['app']`, elle affiche **`(non renseigné)` partout** (`analytics.service.ts:696`) — pire qu'une valeur constante, ça fait "donnée manquante". Fix front pur (~10 lignes) : masquer la colonne quand ≤1 app distincte (ou quand la seule valeur est le fallback).

---

#### B11 — Onglet "En direct" vide sur data mockée · **real_gap — à ÉVITER en démo** · M (si remédiation) · **P2**

`live.tsx` fige ses 7 requêtes sur `previous_30_minutes` = `[now-30min, now]` temps réel. La data mockée est étalée sur 24h (jamais dans cette fenêtre) → "0 en direct" + carte monde déserte (pas un crash, `LiveMap` rend la carte vide proprement). De plus la carte "En direct" est une carte **monde non désactivable** (hors-sujet national).
**Reco pragmatique : ne pas cliquer "En direct" en démo.** Remédiation optionnelle (M) : injecter au seed un flux roulant dans `[now-30min, now]` re-shifté par cron, OU élargir la fenêtre pour les workspaces démo.

---

#### B12 — Comparaison côte-à-côte dans l'onglet Objectifs · **real_gap (frontend, backend prêt)** · M · **P2**

`GoalCard` ne compare qu'une métrique vs période précédente ; `goals.tsx` rend une grille plate sans regroupement par variante/cohorte. Le backend funnel accepte déjà `filters` sur n'importe quelle dimension. **Largement couvert par B1** (le funnel A/B est la bonne surface) ; ce ticket n'est utile que si on veut aussi des cartes objectifs groupées par variante. À déprioriser au profit de B1.

---

#### B13 — Look Ant Design clair "générique" (pas de signature dark premium) · **real_gap** · L · **P2**

Console en thème AntD clair par défaut (`main.tsx:28-49`, `branding.tsx:118-122` force `defaultAlgorithm`), personnalisation limitée à la couleur accent + logo. Pas de dark mode anthracite, pas de typo/espacement signature. Theming poussé = chantier L, hors démo. À arbitrer post-vente.

---

## Proposition de découpage en lots

### LOT 1 — MVP démo présentable (P0, objectif : démo vendable rapidement)

But : ouvrir la console, voir un funnel onboarding **comparé A/B/C, pré-rempli, à la marque du client, sans parasites**.

| # | Item | Effort | Type |
|---|------|--------|------|
| Data-0 | Vérifier/garantir le tag variante sur la data (`properties['variant']` ou `stm_2`) + `goal_name` FR métier + `sdk_version='12.0.0'` | S | data |
| A2 | Dimension `variant` / `goal_property` | S | backend (déclaration) |
| A1 | `segment_by` funnel multi-séries | M | backend dev |
| B4 | Séquence funnel pré-remplie | S | frontend |
| B1 | Sélecteur variante + rendu A/B/C côte à côte | M | frontend |
| B2 | Onglet Tunnel dédié | M | frontend |
| B5 | Tuer le bandeau SDK en démo | S | data/frontend |
| B7 | **Décision** : démo sur instance non-demo (Option A) → white-label natif | ~0 | déploiement |
| B6-quick | Masquer carte monde + récit régional via Explore + reseed FR multi-régions | S | data/config |

> Si A1 glisse, B1 peut livrer en fallback "N appels orchestrés front" — mais A1 est recommandé pour la propreté.

### LOT 2 — Crédibilité / polish vendeur (P1)

A3-value · B3 (entonnoir trapèze) · B6 (widget carte FR + normalisation région) · B8 (bandeaux white-label, si B7=Option B) · B9 (labels FR si non réglé par data).

### LOT 3 — Profondeur produit / nice-to-have (P2)

A3-timeseries · A4 (Experiment natif + uplift/significativité) · B10 (colonne App) · B11 (live peuplé) · B12 (objectifs groupés) · B13 (theming premium).

---

## Critères d'acceptation (vérifiables)

1. **A2** : `POST analytics.funnel` avec `filters:[{dimension:'variant',operator:'equals',values:['A']}]` retourne un funnel filtré (pas de "Unknown dimension").
2. **A1** : `POST analytics.funnel` avec `segment_by:'variant'` retourne **N séries en une requête ClickHouse** (vérifier le `GROUP BY` dans le SQL généré, vérifier que le miroir M2M renvoie la même chose).
3. **A1 rétro-compat** : sans `segment_by`, le contrat mono-série existant est inchangé (tests `funnel-builder.spec.ts` verts).
4. **B1/B2/B4** : ouvrir l'onglet **Tunnel** → entonnoir onboarding pré-rempli + sélecteur Variante → 3 entonnoirs A/B/C côte à côte, taux par étape corrects vs un calcul manuel.
5. **B5** : dashboard du workspace de démo **sans** bandeau "SDK obsolète".
6. **B7** : console de démo affiche logo + couleur + nom du client (pas le violet/logo Veridian).
7. **B6** : aucune carte du monde visible par défaut sur le dashboard de démo ; répartition par région FR consultable.
8. **A3-value** (lot 2) : `FunnelStepResult.value` cohérent avec `SUM(goal_value)` par étape.

---

## Risques & pièges connus (cités du code)

- **windowFunnel ≤ 8 étapes** : `FunnelQueryDto.steps` est borné `@ArrayMinSize(2) @ArrayMaxSize(8)`. La séquence onboarding par défaut (B4) doit tenir dans 2..8.
- **`window_seconds` ≠ bucket temporel** : c'est la fenêtre du `windowFunnel` (défaut = plage entière, bornée 1..7 776 000s = 90j). Ne pas le confondre avec une granularité de série (piège pour A3-timeseries).
- **Map ClickHouse non indexé sur la clé** : filtrer/segmenter sur `properties['variant']` **scanne** (pas de skip-index). OK à l'échelle démo, à surveiller si volume prod réel.
- **Cardinalité de `segment_by`** : sans garde-fou, un `segment_by` sur une dimension à haute cardinalité explose la réponse et la charge ClickHouse. Imposer `SEGMENT_MAX`.
- **Pré-requis data variante** : A2/B1 ne servent à rien si les goals ne portent pas réellement le tag de variante. **Garantir l'ingestion** (track endpoint écrivant `properties['variant']`, ou `stm_2`) AVANT de livrer le front, sinon 3 entonnoirs vides.
- **`region` = texte libre MaxMind anglais** (`geo.service.ts:141`) : pas de référentiel INSEE/département. Une vraie carte FR (B6 lot 2) exige une couche de normalisation des noms.
- **Bandeau SDK = bug de versioning plus large** : `APP_VERSION=12` vs SDK `package.json=10` vs bundle baked `6.1.0`. Le gate `is_demo` masquerait le symptôme — ouvrir un **ticket séparé** pour réaligner les versions (vrai bug latent prod).
- **`IS_DEMO` instance-wide** (`demo.controller.ts:44-47`) : il désactive de force tout le white-label par workspace (`branding.tsx:62-63`) ET la donnée mockée n'alimente jamais la fenêtre "En direct". Le passer par-workspace (B7 Option B) touche aussi auto-login + bannière + lecture seule → testé séparément si retenu.
- **"Funnels nommés persistés" inexistants** : `funnels.set/get/run` n'existent PAS dans le code (0 hit grep). Ne pas s'appuyer dessus ; seul `analytics.funnel` ad-hoc existe.
- **Double surface à maintenir** : toute évolution du contrat funnel doit être répliquée sur `analytics.controller.ts` ET le miroir M2M `admin-platform.service.ts:489`.
- **Seed Apple hardcodé** : `demo.generate()` ne sait produire que le funnel Apple sans variante. **Ne PAS tenter de l'étendre pour ce client** — la data passe par track/inserts dédiés (préfixe `vrddemo_`).

---

## Annexe — Récap des gaps

| ID | Titre | Zone | Verdict | Effort | Prio | Lot |
|----|-------|------|---------|--------|------|-----|
| A1 | `segment_by` funnel multi-séries | backend | **real_gap** | M | P0 | 1 |
| A2 | Dimension `variant`/`goal_property` | backend | real_gap (plomberie prête) | S | P0 | 1 |
| A3-value | Valeur € par étape | backend | real_gap (cheap) | S | P1 | 2 |
| A3-ts | Série temporelle par étape | backend | real_gap | M | P2 | 3 |
| A4 | Experiment natif + uplift/signif. | backend | **real_gap total** | L | P2 | 3 |
| B1 | Comparaison A/B/C UI | frontend | real_gap (UI only) | M | P0 | 1 |
| B2 | Onglet Tunnel dédié | frontend | real_gap | M | P0 | 1 |
| B3 | Entonnoir trapèze premium | frontend | real_gap | S/M | P1 | 2 |
| B4 | Séquence funnel par défaut | frontend | real_gap | S | P0 | 1 |
| B5 | Bandeau SDK obsolète en démo | frontend/data | real_gap (allumé) | S | P0 | 1 |
| B6 | Vue géo nationale FR | front/data | exists_unexposed (data) + real_gap (carte FR) | S→M | P1 | 1/2 |
| B7 | White-label visible | déploiement | **exists_unexposed** | ~0 / S | P0 (décision) | 1 |
| B8 | Bandeaux/footer démo white-label | frontend | real_gap | S | P1 | 2 |
| B9 | Labels FR des objectifs | data (front) | real_gap (surtout data) | S | P1 | 2 |
| B10 | Colonne "App" mono-app | frontend | real_gap (cosmétique) | S | P2 | 3 |
| B11 | "En direct" vide en démo | front/data | real_gap (éviter en démo) | M | P2 | 3 |
| B12 | Objectifs côte-à-côte | frontend | real_gap (couvert par B1) | M | P2 | 3 |
| B13 | Look AntD générique | frontend | real_gap | L | P2 | 3 |

**Chemin critique démo (Lot 1)** : Data-0 → A2 → A1 → B4 + B1 + B2 + B5, décision B7=Option A, B6-quick. Tout le reste est polish post-démo.
