# Scoring tunnel — modèle tiède/chaud (spec d'implémentation)

> **Statut** : modèle V2 **implémenté** dans le bridge réconciliateur.
> **⚠️ La vérité d'implémentation = `veridian-tunnel-de-vente/bridge/src/score-tunnel.ts`**
> (fonction pure `computeTunnelScore`). Ce document décrit la grille V2 telle
> qu'elle tourne ; en cas de doute, le code fait foi.
> Requête d'agrégation validée sur données réelles staging
> (workspace `vrd_veridian_site_staging`, session E2E 2026-06-10).
> Pas de ML — pondération fixe, auditable.
> Contrats amont : CONTRATS-TUNNEL §4a (figé) + `TUNNEL-IDENTITE.md`.

> **Historique V1→V2** : la V1 de ce doc (2026-06-10) décrivait un tracker
> *consent-gated*, `consent_granted = +5`, `scroll = +10`, pas d'`identify`,
> et des `NotifuseSignals` avec `delivered`. Toutes ces hypothèses ont été
> corrigées en V2 (voir §6 « Ce qui a changé »). **Ne pas se fier aux specs
> qui décrivent encore la V1.**

---

## 1. Contrainte fondatrice : deux familles de signaux

Décision Robert 2026-06-11 (CONTRATS-TUNNEL §4a, assumée) : le tracker
Analytics se charge **SANS gate de consentement** sur veridian.site
(first-party). Les events comportementaux existent donc pour **100 % des
visiteurs**. Le scoring reste néanmoins structuré en **deux familles**, car
la famille Notifuse est le seul filet pour un prospect qui n'ouvrirait jamais
sa page audit (mail lu sans clic, ou navigateur qui bloque le SDK) :

| Famille | Couverture | Signaux | Transport |
|---|---|---|---|
| **Notifuse** (server-side) | **100 % des prospects** | `sent`, `opened`, `clicked`, `bounced`, `unsubscribed` | webhook → réconciliateur (+ cron `sweepNotifuse`) |
| **Analytics** (client-side) | tous les visiteurs du site | pageviews, scroll, goals (`cta_click`, `rdv_booked`, `identify(email)`), goals Hub (`signup`, `app_started`), sessions | export.userEvents → réconciliateur (cron ≥ quotidien, TTL 7j) |

> Le tracker n'étant plus consent-gated, `analytics === null` ne signifie plus
> « non-consentant » mais « aucun event site observé pour cette identité »
> (prospect qui n'a pas visité). Le scoring traite ce cas pareil : famille
> Notifuse seule.

Clé de jointure (CONTRATS-TUNNEL §4c figé) : la **Person Twenty** porte les
deux clés — events Notifuse résolus par **email normalisé**
(`filter=emails.primaryEmail[eq]`), events Analytics résolus par **slug**
(`filter=auditSlug[eq]`). Les events arrivent sous `user_id = slug` (ou
email post-`identify(email)`) → le scoring fait l'union des deux user_id de
la même Person.

## 2. Grille de points V2 (= `score-tunnel.ts`)

### Signaux Notifuse (disponibles pour tous)

| Signal | Points | Constante | Note |
|---|---|---|---|
| `bounced` (hard, DSN parser #24) | — | — | flag **`disqualified`** : sort du tunnel, score 0, `doNotContact=true` |
| `unsubscribed` | — | — | flag **`disqualified`** idem |
| `sent` | 0 | — | baseline (déclenche transition stage NEW→SCREENING côté writer, pas de point) |
| `opened` (pixel d'ouverture) | +5 | `OPEN_FIRST` | **NON cumulable** (cap 5) — signal faible/bruité (Apple MPP + proxys pré-chargent), ne passe jamais chaud seul. Activé lead 2026-06-11 |
| `clicked` (1er clic) | +20 | `CLICK_FIRST` | clic tracké server-side → fiable |
| `clicked` (par clic supplémentaire) | +10 | `CLICK_EXTRA` | cap famille clics : **+40** (`CLICK_CAP`) |

> Pas de `delivered` scoré : le relai self-hosted ne l'émet pas de façon
> fiable (le webhook l'accepte si jamais reçu, mais ne le score pas).

### Signaux Analytics

| Signal | Points | Constante | Source agrégat |
|---|---|---|---|
| a vu sa page audit (`auditViews ≥ 1`) | +10 | `AUDIT_VIEW` | `screen_view path LIKE '/audit/%'` |
| scroll profond audit (`auditScrollMax ≥ 75`) | +15 | `AUDIT_SCROLL_75` | `max_scroll` |
| `consent_granted` | **0** | — | tracké pour debug/compliance, **ne score JAMAIS** (tranché lead 2026-06-10) |
| page chaude visitée (`/tarifs`, `/contact`, `/roi`) | +15 chacune, cap +30 | `HOT_PAGE` / `HOT_PAGE_CAP` | `hotPages` |
| autre page visitée (hors audit/chaudes) | +5 chacune, cap +15 | `OTHER_PAGE` / `OTHER_PAGE_CAP` | `otherPages` |
| `cta_click` | +20 (dès le 1er) | `CTA_CLICK` | goal |
| **`identify(email)`** / Hub `signup` (a saisi son email / créé son compte) | **+35** | `IDENTIFY_EMAIL` | `identifiedByEmail` — signal d'intention FORT |
| Hub `app_started` (a démarré Notifuse/Prospection) | **placeholder** | (à figer) | `appStarted` — jalon timeline posé, **poids en attente lead** (reco +40) |
| `rdv_booked` | +50 | `RDV_BOOKED` | goal |
| est revenu (`sessions ≥ 2`) | +15 | `RETURN_VISIT` | `uniqExact(session_id)` |

**Ordre d'intention strict** (croissant) : `AUDIT_VIEW` (10) < `AUDIT_SCROLL_75`
(15) < `CTA_CLICK` (20) < `IDENTIFY_EMAIL`/`signup` (35) < `app_started` (reco
40, à figer) < `RDV_BOOKED` (50). Chaque palier pèse plus que le précédent — un
prospect qui démarre le produit vaut plus qu'un qui donne son email, qui vaut
plus qu'un qui clique un CTA.

**Goals Hub** (contrat events Hub figé 2026-06-11) : `signup` et `app_started`
arrivent via `POST /api/track` avec `user_id = email normalisé`,
`session_id = hub-<userUuid>`. Mappés côté bridge (`analytics-pull.ts`) :
`signup → identifiedByEmail` + jalon `signup` ; `app_started → appStarted` +
jalon `app.started`. Le site n'a pas à connaître ces noms (découplage §4a).

### Modificateur récence + labels

- **Récence** : dernier signal (Notifuse OU Analytics) < 48 h → score ×1,5
  (`RECENCY_MULTIPLIER`, appliqué seulement si score > 0).
- **Cap final : 100** (`SCORE_CAP`).
- **Seuil chaud : 30** (`CHAUD_THRESHOLD`).

| Score | Label | Action commerciale |
|---|---|---|
| flag `disqualified` | — | retirer de la liste d'appel (`doNotContact=true`) |
| 0 | **froid** | pas de signal, relance campagne |
| 1–29 | **tiède** | à rappeler après les chauds |
| ≥ 30 | **chaud** | appel prioritaire (tri desc dans la vue Twenty) |

Sanity-check contrainte §1 : un prospect qui clique 2× le lien du mail sans
jamais visiter le site = 20+10 = 30 → **chaud** sur les seuls signaux
Notifuse. Un visiteur qui lit son audit à fond (10+15) = 25 tiède ; + un clic
CTA = 45 chaud. Saisir son email (+35) ou prendre un RDV (+50) = chaud
d'office.

## 3. Requête ClickHouse d'agrégation (référence, VALIDÉE)

Agrégat par identité sur les events bruts (fenêtre 7 j glissants — TTL).
Validée le 2026-06-10 sur `staminads_ws_vrd_veridian_site_staging` :

```sql
SELECT
  user_id,
  countIf(name = 'screen_view' AND path LIKE '/audit/%')                AS audit_views,
  maxIf(max_scroll, name = 'screen_view' AND path LIKE '/audit/%')      AS audit_scroll_max,
  uniqExactIf(path, name = 'screen_view'
              AND path IN ('/tarifs', '/contact', '/roi'))              AS hot_pages,
  uniqExactIf(path, name = 'screen_view'
              AND path NOT LIKE '/audit/%'
              AND path NOT IN ('/tarifs', '/contact', '/roi'))          AS other_pages,
  countIf(name = 'goal' AND goal_name = 'consent_granted') > 0          AS consented,
  countIf(name = 'goal' AND goal_name = 'cta_click')                    AS cta_clicks,
  countIf(name = 'goal' AND goal_name = 'rdv_booked')                   AS rdv_booked,
  uniqExact(session_id)                                                 AS sessions,
  max(updated_at)                                                       AS last_seen
FROM {ws_db}.events FINAL
WHERE user_id IS NOT NULL
GROUP BY user_id
```

> `identifiedByEmail` n'est pas une colonne de cette requête : il se déduit
> côté réconciliateur du fait que le `user_id` agrégé a la forme d'un email
> (contient `@`) — c'est la bascule slug→email du contrat §4a.

**Consommation par le réconciliateur (dev-pub)** : PAS d'accès ClickHouse
direct (il est sur le serveur prod) — le réconciliateur consomme
`GET /api/export.userEvents` (HTTP, curseur incrémental, auth API key
workspace, **properties incluses depuis fix G1**) et calcule l'agrégat
ci-dessus en mémoire. La requête SQL reste la référence sémantique +
l'outil de debug/vérif (via `docker exec clickhouse-client` sur l'hôte
engine).

## 4. Interface d'implémentation (= `score-tunnel.ts`)

```ts
/** Agrégat Analytics par identité (slug ou email) — cf. requête §3. */
interface AnalyticsAggregate {
  userId: string;            // slug audit OU email normalisé (union des 2 clés)
  auditViews: number;
  auditScrollMax: number;    // 0-100
  hotPages: number;          // /tarifs, /contact, /roi (uniques)
  otherPages: number;        // hors audit + hors chaudes (uniques)
  consented: boolean;        // tracké, ne score jamais
  ctaClicks: number;
  rdvBooked: number;
  identifiedByEmail: boolean; // a saisi son email sur le site (user_id = email)
  sessions: number;
  lastSeen: Date | null;
}

/** État Notifuse par email (webhooks + réconciliation cron). */
interface NotifuseSignals {
  email: string;             // normalisé lowercase+trim
  sent: boolean;             // ≥ 1 email.sent (baseline → SCREENING côté writer)
  clicks: number;            // clics distincts (dédup message_id)
  bounced: boolean;          // hard bounce DSN → disqualified
  unsubscribed: boolean;     // opt-out → disqualified
  lastEventAt: Date | null;
}

interface TunnelScore {
  email: string;
  score: number;             // 0-100 entier
  label: 'froid' | 'tiede' | 'chaud';
  disqualified: boolean;     // bounce dur OU unsubscribe
  lastSignalAt: Date | null;
  components: Record<string, number>; // détail des points (audit Twenty)
}

/** Fonction PURE : (signals, aggregates|null) → score. */
function computeTunnelScore(
  notifuse: NotifuseSignals,
  analytics: AnalyticsAggregate | null,
  now?: Date,
): TunnelScore;
```

`components` est poussé dans Twenty (properties de la timeline) pour que le
commercial voie POURQUOI un prospect est chaud — le score n'est jamais une
boîte noire.

### Écriture Twenty (contrat figé §4c — le réconciliateur code contre ça)

Structure Person LIVRÉE en prod : fields `score` NUMBER, `providerClass`
SELECT, `auditSlug` TEXT, `doNotContact` BOOLEAN, relation `mailingBatch`.
Vue "Tunnel de vente" : tri score DESC, filtre doNotContact=false.

- Score → `PATCH /rest/people/{id} {"score": n}` (agrégé, batché) ; jalon
  timeline optionnel `score.threshold` au franchissement de palier
  (froid→tiède, tiède→chaud).
- Timeline → `POST /rest/batch/timelineActivities` (60/call, ≤60 req/min),
  noms namespacés : `email.sent|clicked|bounced|unsubscribed`,
  `audit.page_view|scroll|cta_click|rdv`. **Digests/jalons uniquement,
  jamais le flux brut.**
- Le flag `disqualified` (hard bounce) se matérialise par
  `doNotContact=true` sur la Person (registre = Twenty, §4c.5) — posé
  aussi sur `email.unsubscribed`.
- Stages : `SCREENING` posé sur `email.sent` si stage=NEW ; un stage ne
  recule JAMAIS automatiquement (§4c.6).

## 5. État des extensions

- ✅ **`email.opened`** — LIVRÉ (validé lead 2026-06-11). +5 non cumulable,
  écrit en timeline + scoré. Câblé : `server.ts` ACCEPTED_TYPES, grille
  `score-tunnel.ts` (`OPEN_FIRST`), agrégat `notifuseSignalsFromStore`,
  reinjection cron `sync.ts` (`['email.opened', m.opened_at]`). Reste côté
  Notifuse : activer le pixel d'ouverture par classe de provider (tâche #30) —
  tant que Notifuse n'émet pas l'event, le scoring reste inerte (opened=false).
- ✅ **Hub `signup`** — LIVRÉ. Mappé `identifiedByEmail` (+35 figé) + jalon
  timeline `signup`.
- ⏳ **Hub `app_started`** — capté (champ `appStarted` + jalon `app.started`),
  **scoring en placeholder** : poids en attente de validation lead (reco +40,
  ordre identify(35) < app_started < RDV(50)). À figer dès la réponse lead.
- ⏳ **Goals futurs site** (navigation, etc.) : noms exacts à venir de l'agent
  site via le lead. Mappés comme goals natifs (zéro dev engine), agrégés dans
  `analytics-pull.ts`, poids à définir au branchement.
- Enforcement suppression-list côté Notifuse à l'envoi (au-delà du registre
  doNotContact Twenty) : à instruire avant le bulk, vérifié au gate #11.

## 6. Ce qui a changé V1 → V2 (pour les specs/agents encore sur la V1)

| Sujet | V1 (périmé) | V2 (code réel) |
|---|---|---|
| Tracker | consent-gated, non-consentant = 0 event | **pas de gate** (Robert 2026-06-11), events pour tous |
| `consent_granted` | +5 | **0** (ne score jamais) |
| `audit_scroll ≥ 75` | +10 | **+15** |
| `identify(email)` | absent | **+35** (signal fort) |
| `NotifuseSignals` | `delivered: boolean` | `sent` + `unsubscribed` (pas `delivered`) |
| `AnalyticsAggregate` | pas d'`identifiedByEmail` | `identifiedByEmail: boolean` |
| Disqualification | bounce seul | bounce **+ unsubscribe** |
| Ordre d'intention | implicite | strict : view < scroll < CTA < identify < RDV |
