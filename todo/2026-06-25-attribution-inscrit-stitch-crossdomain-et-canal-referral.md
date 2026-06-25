# Attribution d'un INSCRIT : recollement cross-domain (identity stitching) + canal "referral" parrainage interne

> **Sévérité** : 🟡 P1 — la provenance native d'un inscrit nommé est FAUSSE (tout en `direct`). KPI d'acquisition par client inexploitables tels quels. Pas bloquant (les events coulent), mais c'est le cœur du produit "d'où viennent mes clients".
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-25
> **Demandé par** : lead Veridian (cas réel Yoga Sculpt — 2 inscrits du 25/06)
> **Prérequis** : chantier attribution S1-S4 (channel derivation + backfill) déjà livré prod v10. Ce ticket = le maillon manquant S6 (identité ↔ provenance).

## Constat terrain (prod, workspace yoga_sculpt, 2026-06-25)

Deux inscrits réels le 25/06, vérifiés via `export.userEvents` + `analytics query` :
- **josephine.pinoit@gmail.com** : gclid capté côté app (Supabase), mais sa session ANALYTIQUE identifiée a `landing_domain=app.yoga-sculpt.fr`, `referrer=yoga-sculpt.fr`, `channel_group=not-mapped`.
- **valentin.treppoz@gmail.com** : landing `app.yoga-sculpt.fr/login?ref=VHCRPP6X` (= code de parrainage de Joséphine), referrer vide → **classé `direct`** par l'engine. C'est en réalité du **parrainage** (1er effet de viralité du client).

Requête de preuve :
```
analytics query yoga_sculpt --metrics sessions,pageviews \
  --dimensions user_id,landing_domain,referrer,channel_group  (preset today)
```
→ **TOUTES les sessions identifiées (user_id != null) ont landing_domain = app.yoga-sculpt.fr** ; **TOUTES les sessions vitrine (yoga-sculpt.fr, qui portent la vraie provenance) ont user_id = null.** Le lien identité↔provenance est rompu.

## Cause racine (2 angles morts, code lu)

1. **Pas de stitch identité au `setUserId`.** Quand un visiteur passe du vitrine (session anonyme A avec le vrai referrer/canal) à l'app puis se logge (`setUserId(email)` → session B), l'engine NE réattribue PAS A à l'email. La provenance d'acquisition vit sur A (anonyme), l'identité sur B (qui démarre sur `/login`, referrer vide → `deriveChannel` = `direct`). Aucun `stitch`/`reattribute` dans le code (`grep setUserId|stitch|reattribut` = rien côté events). Le cross-domain `_stm` recolle peut-être la SESSION, mais pas l'attribution d'acquisition vers le user_id.

2. **Le parrainage interne `?ref=CODE` n'est pas un canal.** `api/src/events/derive-channel.ts` est très complet (paid/organic/social/email/referral externe/direct) MAIS ne connaît ni le param `?ref=` ni les goals `referral_*` (déjà mappés CRM). Un parrainage atterrit en `direct` faute de referrer externe. Or `referral` (interne) est une source d'acquisition à part entière — c'est même la plus rentable (acquisition gratuite dérivée d'un lead payant).

## Demande (réutilisable — vaut pour TOUS les workspaces, zéro code par client)

### A — Identity stitching au `setUserId` (le maillon S6)
Quand un event arrive avec un `user_id` pour une session/visiteur dont des sessions ANTÉRIEURES anonymes existent (même `visitor_id` / même chaîne cross-domain `_stm`), **réattribuer l'acquisition d'origine** (channel/channel_group/referrer/utm/landing de la PREMIÈRE session du visiteur) au `user_id`. Modèle "first-touch" : l'inscrit hérite du canal de sa première visite vitrine, pas du `/login` de l'app.
- Idéalement exposer `first_touch_channel` / `last_touch_channel` (GA4 fait les deux).
- Au minimum : que `analytics query --dimensions user_id,channel_group` donne le VRAI canal d'acquisition de l'inscrit, pas `direct`.

### B — Canal `referral` pour le parrainage interne
- Reconnaître le param d'URL `?ref=<code>` (et/ou la présence d'un goal `referral_landing`/`referral_completed`) comme `channel = referral`, `channel_group = referral` dans `deriveChannel` (ou en post-traitement).
- Le code de parrainage devrait être conservé (dimension `stm_*` ou utm_content) pour savoir QUI a parrainé (ici VHCRPP6X = Joséphine).
- Configurable : le pattern du param ref peut varier par client → idéalement un réglage workspace (ex. `referral_param: "ref"`), sinon `ref` par défaut.

### C — Backfill (cohérence avec S1-S4)
Comme le `channel-backfill` déjà livré : permettre de re-dériver l'attribution des inscrits historiques (Joséphine, Valentin, Michele) une fois A+B en place, pour ne pas perdre les premiers clients.

## Definition of Done
- [ ] `analytics query yoga_sculpt --dimensions user_id,channel_group` montre Valentin en `referral` (pas `direct`) et Joséphine en `ads` (pas `not-mapped`).
- [ ] `export.userEvents` d'un inscrit expose son first-touch channel + (si parrainé) le code parrain.
- [ ] Testé E2E : visiteur vitrine (referrer Google) → app → login → la fiche analytics de l'email porte `organic_search`/`seo`, pas `direct`.
- [ ] CLI : une commande lit la provenance par inscrit (cf ticket CLI séparé ci-dessous).

## Lien CLI (ticket frère, repo skill)
Le CLI `analytics` doit exposer cette provenance par inscrit de façon limpide (ex. `analytics provenance <ws> [--user <email>]` ou enrichir `funnel`), pour que l'agent collecte la data et façonne les KPI d'acquisition d'un site client sans forger des `query`/`export.userEvents` à la main. (Traité côté skill analytics-provision.)
