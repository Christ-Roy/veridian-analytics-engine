# 🎯 CHANTIER — Attribution de bout en bout (source → channel → funnel → CRM → Google Ads)

> **Sévérité** : 🔴 P1 (différenciateur commercial n°1 : "d'où viennent mes clients")
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23 (fusion radicale de 7 tickets de la grappe attribution)
> **Vérifié contre** : `origin/staging` (= prod v10.0.0) + queries M2M réelles sur prod, 2026-06-23

## Pourquoi ce ticket existe (fusion)

Sept tickets décrivaient le MÊME chantier sous des angles différents :
`channel-jamais-calcule-attribution-borgne`, `funnel-tunnel-de-vente-par-canal`,
`taux-creation-conversion-par-app-et-canal`, `tel-tracke-vers-crm-avec-source`,
`crm-distinction-ads-vs-seo`, `ads-conversions-upload-s2s`,
`reporting-acquisition-visiteur-unique-sources-funnel`. Tous tournent autour d'une
seule chaîne : **capter la source d'acquisition d'un visiteur (ads/seo/social/direct),
la propager au channel/funnel, la remonter au CRM, et l'uploader vers Google Ads.**
Fusionnés ici pour éviter 7 agents qui se marchent dessus sur `session-payload.handler`,
`twenty-event-mapper`, `admin-platform`.

## État RÉEL vérifié (ce qui est déjà fait vs ce qui reste)

✅ **DÉJÀ LIVRÉ (ne pas refaire)** :
- **Visiteurs uniques** : `visitor_id` + fingerprint + IP livrés (commit `fd91e83`),
  métrique `unique_visitors` opérationnelle en prod (`query unique_visitors` → 1, vérifié).
- **Capture des signaux source** : `utm_*`, `gclid/gbraid/wbraid` (via `utm_id_from`),
  `referrer`/`referrer_domain`, `is_direct`, `phone_source` (par numéro appelé) — tous captés/stockés.
- **`ads.conversions` (lecture)** : endpoint M2M `POST /api/admin/platform/ads.conversions`
  qui lit les conversions attribuées Ads (gclid/gbraid/wbraid OU phone_source='ads').
- **Bugs query M2M résolus** : presets relatifs (`today`/`previous_7_days`) et dimension
  `referrer_domain` ne renvoient PLUS 500 (vérifié prod 2026-06-23). N'EST PLUS un sujet.
- **Connecteur Twenty natif** : pousse score + timeline + `utmSource` brut (`twenty-event-mapper.ts:229`).

❌ **CASSÉ / NON FAIT (le vrai reste-à-faire)** :
- **`channel`/`channel_group` TOUJOURS VIDES en prod** : hardcodés `''` à l'ingestion
  (`session-payload.handler.ts:337`), AUCUNE dérivation (`grep deriveChannel|classifyChannel`
  = 0). Vérifié prod : `query --dimensions channel_group` → 332 sessions toutes dans `""`.
  → **Le filtre/funnel par canal est BORGNE.** C'est le socle de tout le reste.
- **Aucun funnel** : `grep funnel|windowFunnel` console = 0, pas d'endpoint funnel.
- **CRM sans distinction Ads/SEO** : `twenty-event-mapper.ts` pousse `utmSource` brut, pas
  d'`acquisition_source` normalisée ni de `phone_source`. `phone_call` non mappé vers Twenty.
- **Pas d'upload Google Ads** : `ads.conversions` expose, mais aucun upload vers la Google Ads API.

## Sous-chantiers (ordre de dépendance STRICT)

### S1 — 🔴 Dériver `channel`/`channel_group` à l'ingestion (LE SOCLE)
Sans ça, S2/S3/S5 sont borgnes. Ajouter une dérivation déterministe (util `derive-channel.ts`)
appelée dans `session-payload.handler` à partir des signaux déjà captés, logique "Default
Channel Grouping" GA4-like :

| channel | Règle (ordre de priorité) |
|---|---|
| `paid_search` | `utm_id_from ∈ gclid/gbraid/wbraid` OU `utm_medium ∈ cpc/ppc/paid` |
| `organic_search` | referrer = moteur (google/bing/…) SANS gclid |
| `paid_social` / `organic_social` | referrer réseau social (± utm_medium paid) |
| `email` | `utm_medium=email` OU referrer mail |
| `referral` | referrer externe non classé |
| `direct` | `is_direct` / pas de referrer |
| `other` | reste |

- Channel calculé à l'**ingestion** (figé, perf) — reco. Channel = celui de la 1re visite (acquisition).
- **Aligner les valeurs avec `phone_source`** (seo/ads/direct/email/social/...) pour cohérence web↔appel.
- Migration de backfill optionnelle pour l'historique (via `filter-compiler` qui sait faire `channel=CASE…`).
- Tests : table de cas (gclid→paid_search ; referrer google sans gclid→organic_search ; etc.).
- Fichiers : `api/src/events/session-payload.handler.ts:337`, nouveau `derive-channel.ts`,
  dim déjà câblée (`dimensions.ts:80,87`), schéma déjà OK (`schemas.ts` channel/channel_group).

### S2 — 🟡 Funnel (tunnel de vente) filtrable par canal
- **Backend** : endpoint funnel (workspace-scoped + équivalent M2M) prenant une liste ordonnée
  d'étapes (goal_name/event), une plage de dates, des filtres (dont `channel`/`channel_group`).
  Renvoie par étape : sessions/visiteurs atteignant + taux N→N+1 + taux global.
  ClickHouse `windowFunnel(window)(timestamp, cond1, cond2, …)` est fait exactement pour ça.
- **UI** : vue funnel native staminads (entonnoir) + filtre par canal (réutilise `DashboardFilters`
  + dim channel). PAS de page custom Veridian (vision). Vérifier si staminads upstream a un funnel
  avant de partir de zéro.
- Borner : ≤ 8 étapes, plage de dates. Clé : `session_id` (intra-session) ou `visitor_id` (cross-session).

### S3 — 🟡 Taux de création/conversion par app × canal
- **Volet ENGINE (ici)** : endpoint "conversions par app" = group by `properties['app']` × `channel`,
  métrique = count goals `signup`/`app_started` + taux vs sessions du même canal. Briques OK :
  `signup`/`app_started` portent déjà `properties.app` (`tunnel-aggregator.ts:30-31,139`).
- **Volet HUB (ticket à déposer côté Hub si validé)** : confirmer que Hub/apps poussent `signup`
  avec `app` + attribution au bon workspace analytics. Cross-domain vitrine→Hub = chaîne d'attribution.
  ⚠️ Si le cross-domain vitrine→Hub est flou → demander arbitrage Robert avant de coder ce volet.

### S4 — 🟡 Remonter la source au CRM Twenty (acquisition_source + phone_call)
- Calculer une **`acquisition_source` normalisée** (`google_ads` si gclid OU phone_source=ads ;
  `organic_seo` si referrer Google sans gclid ; `direct` ; …) avec règle de priorité claire
  (gclid > phone_source > referrer > utm) et la pousser dans un champ Twenty lisible/filtrable.
- **Mapper `phone_call`** : ajouter `goal_name='phone_call'` dans `twenty-event-mapper.ts`
  (timeline activity "appel" + `phone_source`). Aujourd'hui non mappé → 0 milestone.
- Test E2E sur le workspace REPLAY (`veridian-3wm3l1xq`). ⚠️ Connecteur Twenty cross-app sensible —
  coordonner avec le contrat tunnel (CONTRATS-TUNNEL §4c). Cf [[project_tunnel_connecteur_twenty_natif_design_b]].
- ⚠️ Recoupe le **Niveau 4 du ticket `ui-configurable-par-workspace`** (mapping CRM configurable).
  Si N4 est lancé en parallèle, S4 doit s'appuyer sur le moteur générique de N4, pas re-hardcoder.

### S5 — 🟡 Upload des conversions → Google Ads API (S2S, F2)
- L'engine EXPOSE déjà via `ads.conversions`. L'**upload** reste au **skill plateforme `google-ads`**
  (qui gère le compte Ads en IaC + a un pipeline offline `ovh-calls-to-ads.py`, ECL, SDK Python,
  MCC 6437191896). PAS de SDK Google Ads embarqué dans NestJS (cf vision "pas de Google Ads natif").
- **Arbitrages Robert (peut partir en review)** :
  1. Mapping `workspace_id → (customer_id Ads, conversion_action_id)` : n'existe nulle part.
     Table engine sérialisée ? config skill ? = vrai manque structurel à trancher.
  2. OAuth multi-compte client : 1 refresh token MCC aujourd'hui. Compte client sous MCC
     (login_customer_id) ou OAuth par client ? **Décision business.**
  3. Voie d'upload : gclid-based (web) et/ou ECL phone-hash (appels).

## Séquençage recommandé
**S1 (channel) D'ABORD** — débloque S2, S3 et S4. Puis S2+S4 en parallèle (périmètres disjoints :
S2=analytics/funnel, S4=connecteur Twenty). S3 après S1. S5 en dernier (dépend d'arbitrages + skill google-ads).

## Tickets absorbés (supprimés au profit de celui-ci)
`channel-jamais-calcule-attribution-borgne`, `funnel-tunnel-de-vente-par-canal`,
`taux-creation-conversion-par-app-et-canal`, `tel-tracke-vers-crm-avec-source`,
`crm-distinction-ads-vs-seo`, `ads-conversions-upload-s2s`,
`reporting-acquisition-visiteur-unique-sources-funnel` (ses Manques 1 et 4 étaient déjà
livrés/résolus ; ne restaient que channel = S1 et ads-keyword = S5).

## Liens
- Review attribution dure : `review/2026-06-22-attribution-gmb-rapprochement-timestamp.md` (GMB, R&D)
- Mapping CRM configurable (industrie) : `2026-06-23-ui-configurable-par-workspace-branding-features-widgets.md` N4
