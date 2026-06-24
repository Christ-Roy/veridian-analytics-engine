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
