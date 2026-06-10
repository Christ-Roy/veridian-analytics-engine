# Identité tunnel de vente — user_id / slug dans ClickHouse

> **Statut** : chaîne validée E2E sur staging le 2026-06-10 (session
> `e2e-identity-1781091442`, workspace `vrd_veridian_site_staging`).
> Aucun dev moteur requis : la chaîne staminads native (SDK `setUserId` →
> `POST /api/track` → ClickHouse `events.user_id` → `GET /api/export.userEvents`)
> est complète, testée (`api/test/user-id-export.e2e-spec.ts`) et déployée
> en prod (`main` @ `097da30`).
>
> Ce doc est le contrat de référence côté engine pour : l'agent
> `veridian-site` (pages audit outbound + identify inbound) et le scoring
> tunnel (sync vers Twenty). Version cross-app figée par le team-lead dans
> `veridian-tunnel-de-vente/docs/CONTRATS-TUNNEL.md` §4.

---

## 1. Diagnostic obsolète — à connaître

La synthèse faisabilité du 2026-06-01 (`SYNTHESE-FAISABILITE.md` §3)
diagnostiquait « lien email↔events cassé : le bridge met `lead_id` dans
`attributes`, pas dans `user_id` ». **Ce diagnostic ne s'applique plus** :

- Le module forms du bridge (`Lead`/`LeadSession`/`FormSubmission`) a été
  **supprimé** au commit `b3f7869` (alignement scope commercial 2026-05-25).
  Doctrine repo : pas de Lead custom, on utilise les goals staminads natifs.
- L'identité passe désormais par le **chemin natif staminads**, qui est
  complet de bout en bout. Il n'y avait plus rien à câbler — seulement à
  valider en conditions réelles, c'est fait.

## 2. Le mécanisme d'identité (comment ça marche)

```
SDK (site)                          Engine (NestJS)              ClickHouse
──────────                          ───────────────              ──────────
Staminads.setUserId(<id>)
  → persisté localStorage           POST /api/track
  → payload.user_id sur CHAQUE      → SessionPayloadHandler      events.user_id
    flush suivant (full resend        buildBaseEvent:              (Nullable(String),
    de TOUTES les actions de la       user_id sur chaque event     index bloom_filter)
    session)                          du payload                 + sessions/pages/goals
                                                                   via MV (user_id aussi)
```

Propriétés clés (toutes validées E2E + couvertes par
`user-id-export.e2e-spec.ts`) :

- **Rétro-attribution intra-session** : le SDK ré-envoie TOUTES les actions
  de la session à chaque flush (« no checkpoint, server uses
  ReplacingMergeTree »). Un `setUserId()` en milieu de session ré-émet les
  pageviews déjà vus avec le `user_id` → ClickHouse (`ReplacingMergeTree(_version)`,
  dedup par `(session_id, dedup_token)`, lecture `FINAL`) remplace les
  lignes anonymes. **Tout le parcours de la session devient identifié,
  y compris ce qui s'est passé avant l'identify.**
- **Persistance cross-session** : le `user_id` est en localStorage → les
  sessions suivantes du même navigateur portent l'identité dès le 1er event.
- **Contraintes** : `user_id` ≤ 256 chars (DTO + SDK), string libre.

## 3. Contrat pages audit OUTBOUND (consommé par veridian-site)

Le slug `/audit/<slug>` (pattern figé : `<domaine-sans-tld>-<suffixe-opaque>`)
EST l'identité du prospect. À l'arrivée sur la page audit :

1. Le tracker site (déjà câblé, gated consent) charge normalement —
   workspace `vrd_veridian_site_prod`.
2. **La page audit appelle `identify(slug)`** (le wrapper site
   `veridian-tracker.tsx` mappe `identify(x)` → `Staminads.setUserId(x)`).
   → `user_id = <slug>` sur tout le parcours, y compris s'il quitte la
   page audit pour /tarifs, etc., et sur ses visites ultérieures.
3. Si le prospect s'identifie ensuite par email (form/signup), le site
   appelle `identify(<email normalisé lowercase+trim>)` → le `user_id`
   **bascule** de slug à email (la session courante est ré-attribuée à
   l'email, les sessions passées restent sur le slug). La réconciliation
   slug↔email est connue du batch (audit JSON) — le scoring fait l'union
   des deux clés.

### Taxonomie events (proposition engine, à figer dans CONTRATS-TUNNEL §4)

| Event tunnel | Implémentation | Code site |
|---|---|---|
| `audit_page_view` | **automatique** — `screen_view` avec `path=/audit/<slug>` | rien (pageview auto) |
| `scroll_depth` | **automatique** — `max_scroll` (25/50/75/100) porté par le pageview | rien (scroll auto) |
| consent | goal `consent_granted` / `consent_denied` | `track('consent_granted')` au choix banner |
| CTA | goal `cta_click`, `properties: {cta: '<nom>'}` | `track('cta_click', {cta})` |
| RDV Cal.com | goal `rdv_booked` | déjà câblé (`cal-cta-button.tsx`) + identify viendra du webhook |
| identify | `setUserId` (PAS un goal) | `identify(slug)` à l'arrivée audit, `identify(email)` au form |

⚠️ **Pas d'endpoint custom** : `POST /api/ingest` n'existe pas sur l'engine
(404 constaté — c'était le schéma du legacy Next.js archivé). Le seul path
d'ingestion est **`POST /api/track`** (public, `workspace_id` dans le body),
et le site n'a même pas à le connaître : le SDK fait tout.

## 4. Lire le parcours d'un prospect (consommé par le scoring)

```
GET /api/export.userEvents?workspace_id=vrd_veridian_site_prod
    &user_id=<slug-ou-email>&since=<ISO>&until=<ISO>&limit=1000
Authorization: Bearer <JWT user> | X-Api-Key workspace
```

- Retourne les events (`screen_view` + `goal`) avec UTM complets, paths,
  scroll, durées, device/geo — pagination curseur (`next_cursor`/`has_more`)
  → sync incrémentale vers Twenty.
- Sans `user_id` : tous les events identifiés du workspace
  (`user_id IS NOT NULL`) — c'est la requête du cron de réconciliation.
- Lecture `FROM events FINAL` → dedup ReplacingMergeTree gérée.

## 5. Contraintes structurantes (à ne pas découvrir en prod)

1. **TTL 7 jours sur les events bruts** (`events` :
   `TTL received_at + INTERVAL 7 DAY`). L'export raw ne voit que les
   7 derniers jours glissants → **le cron de sync scoring → Twenty doit
   tourner au moins quotidiennement** ; l'historique long vit dans Twenty
   (timeline) et dans les tables agrégées `sessions`/`pages`/`goals`
   (user_id propagé par MV, pas de TTL).
2. **Consent-gated** : le loader tracker du site ne s'active qu'après
   acceptation de la catégorie Analytics → **zéro event pré-consentement**
   (et donc zéro scoring sur les prospects qui refusent/ignorent le
   bandeau). Légalement obligatoire, à intégrer dans les attentes de
   volumétrie du tunnel.
3. **Changement d'identité** : 1 navigateur = 1 `user_id` courant. La clé
   de réconciliation finale reste l'**email normalisé** (Twenty) ; le slug
   est une identité de pont, mappée à l'email par le batch.

## 6. Workspaces tunnel

| Env | workspace_id | Provisionné |
|---|---|---|
| staging | `vrd_veridian_site_staging` | 2026-06-02 (`docs/PROVISIONING-WORKSPACE.md`) |
| prod | `vrd_veridian_site_prod` | 2026-06-02 |

Validation E2E rejouable : POST 2 payloads (anonyme puis identifié) sur
`/api/track` staging, puis `export.userEvents?user_id=` → le parcours
complet (3 events, valeurs post-identify) doit revenir. Cf. spec
`api/test/user-id-export.e2e-spec.ts` qui couvre le même scénario en CI.
