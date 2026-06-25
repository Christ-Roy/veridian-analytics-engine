# S6 — Attribution juste : identity stitching + canal referral interne

> **Statut** : spec consolidée 2026-06-25 (4 audits read-only + data prod réelle).
> **Sévérité** : 🟡 P1 — le KPI central "d'où viennent mes clients" est faux (tous
> les inscrits nommés tombent en `direct`/`not-mapped`). Cas réel : Yoga Sculpt.
> **Prérequis vérité-donnée** de la vision data-max
> ([[project_vision_analytics_data_max_ui_custom_replay]]).

## Constat prouvé en prod (Yoga Sculpt, 2026-06-25)

`analytics --env prod query yoga_sculpt --metrics sessions --dimensions channel_group,landing_domain` :
- provenance riche (search-paid 7, search-organic 1, direct 11) = sur la VITRINE
  `yoga-sculpt.fr`, sessions ANONYMES (user_id=null).
- les inscrits (user_id != null) = tous sur `app.yoga-sculpt.fr`, channel `not-mapped`/`direct`.
- josephine.pinoit → not-mapped (a un gclid → devrait être search-paid).
- valentin.treppoz → direct (arrivé via ?ref=VHCRPP6X parrainage → devrait être referral).

Le lien identité↔acquisition est rompu : la 1ère session (vitrine, vrai canal,
anonyme) et la session identifiée (app /login, channel=direct, user_id=email) sont
deux lignes que RIEN ne relie.

## Cause racine (3 angles morts, code lu)

1. **SDK — visitor_id pas stable cross-domain** (`sdk/src/core/session.ts`,
   `cross-domain.ts`). visitor_id en localStorage par origine ; le `_stm` ne
   transporte que `session_id {s,t}`. `createSessionFromCrossDomain` re-minte un
   visitor_id neuf sur l'app. → pas de clé d'identité partagée vitrine↔app.
2. **deriveChannel — ?ref= jamais lu** (`derive-channel.ts`, `session-payload.handler.ts:543`
   `parseUrl()` jette `url.search`). `referral` existe comme channel mais seulement
   pour referrer externe non classé.
3. **Aucun stitch + pas de table first-touch** (`session-payload.handler.ts`). Au
   login, user_id juste copié ; aucun lookup de l'acquisition d'origine. Les MV
   (`sessions_mv`/`goals_mv`) figent `any(e.channel)` par session, ne re-traitent
   jamais le passé.

## Décisions d'architecture (validées par les 4 audits)

| Décision | Choix retenu | Pourquoi |
|---|---|---|
| Où vit le first-touch | **Nouvelle table `user_attribution`** (ReplacingMergeTree ORDER BY identity_key) | Découple de l'attribution-par-session existante → ZÉRO régression métriques (visiteurs uniques/sessions/funnel) |
| Réécrire sessions.channel ? | **NON** | La session /login EST légitimement direct ; first-touch = autre dimension. Réécrire = double-comptage + course ReplacingMergeTree |
| Alimentation | **Service applicatif** best-effort async au 1er event avec user_id (modèle `activateWorkspace`), PAS une MV | Une MV ne peut pas lookup la 1ère session d'un autre visiteur |
| Canal referral | parser `?ref=` à l'**ingestion** depuis `landing_page` (zéro release SDK) + 1 branche `deriveChannel` + `settings.referral_param` (défaut `ref`) | Marche pour tous les clients sans toucher leurs snippets |
| Stocker QUI parraine | `utm_content` (zéro migration) | Déjà colonne + dimension + export |
| Migration | **v12 ADDITIVE** (CREATE TABLE IF NOT EXISTS + éventuel ADD COLUMN + DROP/CREATE MV), modèle v10 | Pas de blue-green (rien de destructif) |
| Backfill historique | nouveau `IdentityBackfillService` calqué `ChannelBackfillService`, sur `sessions`/`goals` | events ont TTL 7j → inutilisables pour l'historique |
| Clé de jointure | **session_id** (la session app adopte le session_id vitrine via `_stm`) pour la voie 2 ; **visitor_id** propagé dans `_stm` pour la voie 1 | À PROUVER on-premise avant de coder le stitch |

## Plan d'exécution (séquencé par dépendance)

### Lot B — Canal referral `?ref=` (QUICK WIN, ingestion-only, zéro migration)
- Parser `?ref=` depuis `landing_page` dans `buildBaseEvent` (param configurable `settings.referral_param`, défaut `ref`).
- Signal `referral_code` ajouté à `ChannelSignals` + branche prioritaire avant `direct` dans `deriveChannel`.
- Code parrain → `utm_content`.
- e2e ClickHouse réel : Valentin passe direct → referral. Sabotage.
- **Débloque le parrainage sans rien d'autre.**

### Lot A — Identity stitching first-touch (cœur, migration v12 additive)
1. **PROUVER on-premise** que session vitrine et app partagent le session_id (voie 2). Sinon → voie 1 (SDK).
2. Migration v12 : table `user_attribution` dans chaque DB workspace + MAJ `WORKSPACE_SCHEMAS` + bump APP_MAJOR_VERSION 11→12.
3. Service de stitch best-effort async (modèle `activateWorkspace`) : au 1er event avec user_id, lookup la 1ère session de la chaîne, upsert `user_attribution[user_id]` avec first-touch + last-touch.
4. Dimensions `first_touch_channel`/`first_touch_channel_group` dans `dimensions.ts`.
5. e2e réel : un inscrit hérite du canal de sa 1ère visite vitrine. Sabotage.

### Lot A+ — SDK (vrai fix robuste, release SDK + redéploiement 5 snippets)
- Étendre `CrossDomainPayload` → `{s,t,v}` : porter le visitor_id, l'adopter à l'arrivée (au lieu de minter).
- Capter `?ref=` côté SDK (param configurable) + propager dans `_stm`.
- Corriger le README (visitor_id = localStorage, pas cookie 13 mois).
- Cookie 1st-party domaine parent en option (robustesse ITP).
- **Rend le stitch robuste multi-session/multi-jour** (la voie 2 ne couvre que le parcours continu).

### Lot TWENTY — "le CRM de l'analytics" (cible business Robert 2026-06-25)
La provenance stitchée doit remonter dans le CRM Twenty (cf
[[project_twenty_crm_de_lanalytics_provenance]]). Le connecteur S4 existe déjà
(`twenty-event-mapper.ts:336+` pousse une acquisition source en timeline sur le
goal `signup`) MAIS lit la source de l'event (/login → direct = faux).
- Une fois S6 livré, le connecteur pousse la VRAIE first-touch source (stitchée)
  — vérifier qu'il lit bien la provenance corrigée, pas le channel du signup brut.
- Ajouter le push de la provenance en CHAMP Person Twenty (pas que timeline) :
  `acquisitionSource`/`firstTouchChannel` + `referralCode` → fiche lead filtrable.
  (Le client Twenty n'a pas de patchPerson aujourd'hui — scope timeline only ;
  ajouter un patch de champ Person dédié à l'acquisition, distinct de person.score
  qui appartient au bridge.)
- ⚠️ Tester via REST+Bearer workspace TEST (Lab/REPLAY), JAMAIS le MCP Twenty
  (= prod réelle, [[feedback_twenty_mcp_points_to_real_prod]]).

### Lot C — Backfill historique + surface query/CLI
- `IdentityBackfillService` (sur sessions/goals, idempotent, mutations_sync=2, emit backfill.completed).
- Endpoint M2M `analytics.userProvenance` (agrège par inscrit) + `backfill.identity`.
- `export.userEvents` : ajouter first_touch_* (+ exposer en M2M ou via provenance).
- CLI `analytics provenance <ws> [--user <email>]` + `analytics backfill <ws> --identity` (`~/.claude/skills/analytics-provision/bin/analytics`) + MAJ SKILL.md.
- Re-stitcher Joséphine/Valentin/Michele.

## Pièges (mémoires)
- ZÉRO build local (RAM 7.6Gi). Tout sur dev-pub/CI.
- MV ne récupèrent PAS les colonnes ajoutées → DROP+CREATE (piège v6/v10).
- Tout fix data = e2e VRAI ClickHouse + sabotage ([[feedback_mock_cache_le_bug_tester_clickhouse_reel]]).
- Backfill total-preserving (uniqExact invariant), émet backfill.completed (invalide cache).
- `any(e.user_id)` non-déterministe dans sessions_mv → pour un lookup fiable, requêter events (<7j) ou poser user_id stable.
- Multi-device institchable sans clé serveur (email) — hors scope V1, assumé.
- ITP/Safari purge localStorage → stitch best-effort, pas 100%.
