# funnel et conversions comptent un nombre DIFFÉRENT de sessions pour le même goal (116 vs 127 sur `signup`)

> **Sévérité** : 🟡 P1 — deux surfaces (funnel / conversions) donnent deux chiffres pour la même conversion, le client ne sait pas lequel croire
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24

## Symptôme (reproductible)

Workspace `vrd_veridian_site_staging`, all_time, goal `signup` :

```
$ analytics --env staging funnel vrd_veridian_site_staging --steps signup,app_started --preset all_time
  → entered (étape signup) = 116

$ analytics raw POST /api/admin/platform/analytics.conversionsByChannel \
    --data '{"workspace_id":"vrd_veridian_site_staging","dateRange":{"preset":"all_time"},"conversion_goals":["signup"]}'
  → channel_group "direct" : 11 conversions
  → channel_group ""       : 116 conversions
  → TOTAL signup = 127
```

**116 (funnel) ≠ 127 (conversions)** pour le même goal `signup`, même fenêtre, même table source (`goals`). Écart = exactement les **11** du canal `direct`.

## Cause probable

Les deux comptent sur la table `goals` mais avec une clause de garde différente sur l'unité :

- **Funnel** (`api/src/analytics/lib/funnel-builder.ts` L61-62) :
  ```
  const unitGuard = unit === 'visitor' ? `AND visitor_id != ''` : `AND session_id != ''`;
  ```
  → en mode `session` (défaut), le funnel **exclut les goals dont `session_id` est vide**.

- **conversionsByChannel** (`api/src/analytics/analytics.service.ts` L600-608) :
  ```
  SELECT channel_group, properties['app'] AS app, uniqExact(session_id) AS conversions
  FROM goals WHERE ... goal_name IN (...) GROUP BY channel_group, app
  ```
  → **aucune exclusion de `session_id = ''`**. Les goals à session_id vide sont comptés (collapsés en un bucket `uniqExact('')` = 1 par groupe, ou comptés selon leur channel_group).

Les 11 goals `signup` du canal `direct` ont vraisemblablement un `session_id` vide (ou un session_id que le funnel écarte), d'où leur présence dans conversions et leur absence dans le funnel. À confirmer en SQL :
```
SELECT channel_group, count(), uniqExact(session_id), countIf(session_id='') FROM goals WHERE goal_name='signup' GROUP BY channel_group
```

## Correctif (voie propre)

Aligner la définition d'« une conversion » entre les deux surfaces. Décision produit à prendre :

- **Si une conversion DOIT être rattachée à une session** (cohérent avec un produit web analytics) : appliquer le même `AND session_id != ''` dans `conversionsByChannel` que dans le funnel. Les goals orphelins (session_id vide) ne devraient de toute façon pas exister — voir aussi pourquoi ces goals `signup` n'ont pas de session_id (bug d'ingestion VoIP/webhook ? cf goals `phone_call` poussés par le bridge).
- **Et/ou** : creuser POURQUOI 11 goals `signup` sur staging ont un session_id vide. Si ce sont des goals serveur-à-serveur (conversions Ads uploadées, events phone_call) sans session web, alors « conversion » et « session convertie » sont deux notions distinctes et il faut le refléter explicitement dans les deux endpoints (compter / nommer pareil).

Recommandation : ajouter `AND session_id != ''` à `conversionsByChannel` pour aligner sur le funnel, ET ouvrir l'investigation sur l'origine des goals sans session_id (probable cause amont commune avec le `channel_group` vide).

## Impact

- Le client qui compare le compteur de conversions du funnel et celui du tableau « conversions par canal » voit deux chiffres → perte de confiance.
- Lié aux tickets `2026-06-24-channel-group-vide-sessions-historiques.md` (channel vide) et `2026-06-24-conversions-denominateur-partage-par-app.md` (dénominateur). Les trois pointent vers la qualité d'attribution des goals.

## Résolution — 2026-06-25 (agent attribution)

Reproduit en réel sur staging : la divergence du ticket (116 vs 127) était
**latente** au moment du fix (les données ont bougé, plus aucun goal à
session_id vide). Query directe confirmée : `empty_sid=0` partout, 12 workspaces.

Cause structurelle réelle : le funnel applique `AND session_id != ''` (mode
session), `conversionsByChannel` non → divergence dès qu'un goal orphelin
(session_id vide) existe. Question produit tranchée : les goals S2S (phone_call
VoIP) synthétisent un session_id non vide (`voip:ovh:<id>`) → ils sont comptés
identiquement par les deux surfaces. Le seul cas de divergence = un goal
orphelin, qui ne doit PAS compter comme conversion.

**Fix** : `AND session_id != ''` ajouté à `conversionsByChannel`
(analytics.service.ts) → invariant `funnel == sum(conversions)` garanti quel que
soit l'état des données. Prouvé sur vrai ClickHouse avec un orphelin contrôlé :
pré-fix conversions=6 vs funnel=5, post-fix conversions=5 == funnel=5. e2e réel
(`api/test/funnel-conversions-parity.e2e-spec.ts`) + unit guard SQL. Commit
`fix(analytics): align conversionsByChannel session_id with funnel`.
