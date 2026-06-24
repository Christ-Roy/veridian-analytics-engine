# Robustesse mineure — lot P2/P3 divers (admin-platform, GSC, ingestion)

> **Sévérité** : 🟢 P2 / 🔵 P3
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

Lot de petits correctifs de robustesse confirmés à l'audit, sans urgence,
regroupés pour ne pas fragmenter. Aucun ne casse la prod ; tous sont des
durcissements propres.

## 🟢 P2 — `tracking.verify` : race entre 2 verify concurrents → faux négatif

`admin-platform.service.ts:979-980, 1132-1160` : `session_id`/`dedup_token` du
verify sont déterministes (`__veridian_verify__${workspaceId}`). Si deux verify
tournent en parallèle sur le même workspace, la purge de A
(`ALTER TABLE events DELETE WHERE session_id=...`) peut supprimer le row de B
avant que B ait poll → B renvoie `ingestion_failed` à tort. Pas de pollution
(sentinel + purge intacts), juste un verdict erroné.
**Correctif** : suffixer l'identité par un nonce court par appel
(`__veridian_verify__${workspaceId}_${randomBytes}`) et purger ce nonce précis.

## 🟢 P2 — `forbidNonWhitelisted` absent du ValidationPipe global

`main.ts` ValidationPipe a `whitelist: true, transform: true` mais pas
`forbidNonWhitelisted`. Les champs inconnus sont stripés (bien) mais pas rejetés —
masque les erreurs d'intégration et autorise du bruit avant strip.
**Correctif** : ajouter `forbidNonWhitelisted: true` (+ `forbidUnknownValues: true`),
en testant contre le SDK réel pour ne pas casser un champ legacy.

## 🔵 P3 — `analyticsQuery` M2M : format d'erreur 404 incohérent

`admin-platform.service.ts:351-353` délègue à `analytics.service.query` sans
pré-vérifier l'existence du workspace → 404 NestJS brut
(`Workspace X not found`), au format différent des autres endpoints M2M (qui
renvoient `{error:'workspace_not_found', message}` via `assertWorkspaceExists`).
Pas de fuite cross-workspace (DB-per-workspace), juste une incohérence de contrat
d'erreur pour le Hub.
**Correctif** : `assertWorkspaceExists` avant délégation, pour un message d'erreur
homogène.

## 🔵 P3 — GSC : `ALTER TABLE … DELETE` redondant dans `replaceDailyWindow`

`gsc.repository.ts:172-184` : un DELETE (mutation async coûteuse) précède un
INSERT qui ne l'attend pas. La table est `ReplacingMergeTree` + lectures `FINAL` +
même ORDER BY → le DELETE est inutile pour la correction (l'INSERT avec
`updated_at` plus récent suffit). Mutation superflue à chaque sync.
**Correctif** : supprimer le DELETE, laisser ReplacingMergeTree+FINAL faire le
travail (cohérent avec le pattern webhooks/api-keys du repo).

## 🔵 P3 — GSC : state OAuth sans expiry ni nonce (replay théorique)

`gsc-oauth.service.ts` `buildState`/`parseState` : state = `workspaceId.HMAC(workspaceId)`,
déterministe et permanent. Impact réel quasi-nul (state sans secret, le `code`
Google est one-shot et expire), mais ce n'est pas un nonce CSRF one-shot.
**Correctif (durcissement)** : inclure un timestamp dans le payload signé et
rejeter au-delà de ~10 min.

## 🔵 P3 — `/setup` : défense-en-profondeur (rescapé du followup code-review 2026-05-25)

Le backend lock existe déjà (`POST /api/setup.initialize` → 400 si setup complété, vérifié),
donc le risque réel est faible. Mais `GET /setup` sert toujours le shell SPA en 200 (défense JS only).
Durcissement défense-en-profondeur, à faire en passant : (a) middleware NestJS qui `302 /login` sur
`/setup` quand `isSetupComplete()` ; (b) `@Throttle({ default: { limit: 3, ttl: 60_000 } })` sur
`SetupController.initialize()`. Le reste du followup 2026-05-25 (helmet/CSP/x-powered-by, phone-source,
toast delete VoIP) est LIVRÉ ; la dette `VITE_VERIDIAN_ADMIN_KEY` se résorbe avec l'archivage du
client legacy résiduel (`console/src/veridian/api.ts`, cf ticket `hygiene-fichiers-residuels-console`).

## 🟢 P2 — `ads.conversions` (28j fixe) vs `conversions` (preset configurable) : fenêtres par défaut irréconciliables (audit data 2026-06-24)

Deux endpoints censés parler des MÊMES conversions ont des fenêtres par défaut
différentes, donc impossibles à réconcilier sans passer des dates explicites :

- `conversions` / `conversionsByChannel` : accepte `preset: all_time` (et tous
  les presets) → couvre tout l'historique.
- `ads.conversions` : `ADS_DEFAULT_LOOKBACK_DAYS = 28`
  (`admin-platform.service.ts:108`) en l'absence de range → fenêtre glissante 28j.

Constaté : `analytics --env staging ads:conversions vrd_veridian_site_staging`
renvoie `from=2026-05-27 → to=2026-06-24` (28j) avec `count: 0`, alors que
`conversions --preset all_time` renvoie 130 conversions sur tout l'historique.
Un agent/IA qui croise les deux sans aligner les dates conclura à tort qu'« il y
a des conversions mais zéro côté Ads ».
**Correctif** : documenter explicitement la fenêtre par défaut dans la réponse
`ads.conversions` (déjà fait : `from`/`to` présents — bien) ET dans le contrat
M2M / skill, pour que tout croisement passe par des dates explicites. Optionnel :
aligner le défaut sur `previous_30_days` comme les autres probes pour cohérence.

## 🟢 P2 — Throttler M2M `default` se déclenche bien avant la limite annoncée (429 sur ~4 req)

`app.module.ts` configure `default: { limit: 100, ttl: 60000 }` (100 req/min) et
`analytics: { limit: 1000 }`. Mais les routes M2M `admin-platform` (sous le
throttler `default`, pas `analytics`) renvoient `429 Too many requests` après
seulement ~4 requêtes rapprochées en lecture (constaté à l'audit data 2026-06-24 :
une série de `query --dimensions` espacée de 8-12s prenait des 429 ; il a fallu
~25s entre appels pour passer). Soit le bucket `getTracker (workspace_id+IP)`
range ces lectures M2M dans une fenêtre plus stricte que prévu, soit le `default`
effectif diffère de la config lue.
**Impact concret** : une console / un Hub qui charge plusieurs widgets dashboard
en parallèle (status + plusieurs `query` + conversions) se prendra des 429 sur un
usage légitime. À vérifier : les routes analytics M2M de lecture devraient être
sous le throttler `analytics` (1000/min), pas `default` (100/min) — et confirmer
le comportement réel du `CustomThrottlerGuard.getTracker` pour ces routes.
**Correctif** : décorer les routes M2M de lecture analytics avec le throttler
`analytics`, et ajouter un test qui vérifie qu'on tient > N req/min en lecture.

## Impact si non corrigé

Aucun risque prod immédiat. Ce sont des durcissements (cohérence de contrat,
mutations superflues, durcissement CSRF, robustesse verify, cohérence de fenêtres
et de throttling pour les croisements M2M). À traiter en remplissage quand un
agent passe sur ces modules.
