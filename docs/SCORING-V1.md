# Scoring tunnel V1 — modèle tiède/chaud (spec d'implémentation)

> **Statut** : modèle posé 2026-06-10 (demande lead, tâche team #14/#17).
> Requête d'agrégation **validée sur données réelles** staging
> (workspace `vrd_veridian_site_staging`, session E2E du 2026-06-10).
> Implémentation cible : **bridge réconciliateur dev-pub** (spec architecte
> #17, CONTRATS-TUNNEL §7). Pas de ML — pondération fixe, auditable.
> Contrats amont : CONTRATS-TUNNEL §4a (figé) + `TUNNEL-IDENTITE.md`.

---

## 1. Contrainte fondatrice : deux familles de signaux

Le tracker Analytics est **consent-gated** (§4a) : un prospect qui refuse ou
ignore le bandeau cookies ne produit AUCUN event Analytics. Le scoring doit
donc fonctionner avec les **seuls events Notifuse** pour ces prospects :

| Famille | Couverture | Signaux | Transport |
|---|---|---|---|
| **Notifuse** (server-side) | **100 % des prospects** | `sent`, `delivered`, `clicked`, `bounced` | webhook → réconciliateur (+ cron) |
| **Analytics** (client-side) | consentants uniquement | pageviews, scroll, goals (`consent_granted`, `cta_click`, `rdv_booked`), sessions | export.userEvents → réconciliateur (cron ≥ quotidien, TTL 7j) |

Clé de jointure (CONTRATS-TUNNEL §4c figé) : la **Person Twenty** porte les
deux clés — events Notifuse résolus par **email normalisé**
(`filter=emails.primaryEmail[eq]`), events Analytics résolus par **slug**
(`filter=auditSlug[eq]`). Les events arrivent sous `user_id = slug` (ou
email post-identify) → le scoring fait l'union des deux user_id de la même
Person.

## 2. Grille de points V1

### Signaux Notifuse (disponibles pour tous)

| Signal | Points | Note |
|---|---|---|
| `bounced` | — | flag **`disqualified`** : sort du tunnel, pas de score |
| `delivered` | 0 | baseline (statut "Contacté") |
| `clicked` (1er clic) | +20 | le clic est tracké server-side → fiable à 100 % |
| `clicked` (par clic supplémentaire) | +10 | cap famille clics : **+40** |

### Signaux Analytics (consentants uniquement)

| Signal | Points | Source agrégat |
|---|---|---|
| a vu sa page audit (`audit_views ≥ 1`) | +10 | `screen_view path LIKE '/audit/%'` |
| scroll profond audit (`audit_scroll_max ≥ 75`) | +10 | `max_scroll` |
| `consent_granted` | +5 | goal |
| page chaude visitée (`/tarifs`, `/contact`, `/roi`) | +15 chacune, cap +30 | `hot_pages` |
| autre page visitée (hors audit/chaudes) | +5 chacune, cap +15 | `other_pages` |
| `cta_click` | +20 (dès le 1er) | goal |
| `rdv_booked` | +50 | goal |
| est revenu (`sessions ≥ 2`) | +15 | `uniqExact(session_id)` |

### Modificateur récence + labels

- **Récence** : dernier signal (Notifuse OU Analytics) < 48 h → score ×1,5.
- **Cap final : 100.**

| Score | Label | Action commerciale |
|---|---|---|
| flag `disqualified` | — | retirer de la liste d'appel |
| 0 | **froid** | pas de signal, relance campagne |
| 1–29 | **tiède** | à rappeler après les chauds |
| ≥ 30 | **chaud** | appel prioritaire (tri desc dans la vue Twenty) |

Sanity-check de la contrainte §1 : un non-consentant qui clique 2× le lien
du mail = 30 → **chaud** sans aucun event Analytics. Un consentant qui lit
son audit à fond (10+10+5) = 25 tiède ; + un clic CTA = 45 chaud. Un RDV
Cal.com = chaud d'office.

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

**Consommation par le réconciliateur (dev-pub)** : PAS d'accès ClickHouse
direct (il est sur le serveur prod) — le réconciliateur consomme
`GET /api/export.userEvents` (HTTP, curseur incrémental, auth API key
workspace) et calcule l'agrégat ci-dessus en mémoire. La requête SQL reste
la référence sémantique + l'outil de debug/vérif (via `docker exec
clickhouse-client` sur l'hôte engine).

## 4. Interface d'implémentation (réconciliateur)

```ts
/** Agrégat Analytics par identité (slug ou email) — cf. requête §3. */
interface AnalyticsAggregate {
  userId: string;            // slug audit OU email normalisé
  auditViews: number;
  auditScrollMax: number;    // 0-100
  hotPages: number;          // /tarifs, /contact, /roi (uniques)
  otherPages: number;        // hors audit + hors chaudes (uniques)
  consented: boolean;
  ctaClicks: number;
  rdvBooked: number;
  sessions: number;
  lastSeen: Date;
}

/** État Notifuse par email (webhooks + réconciliation). */
interface NotifuseSignals {
  email: string;             // normalisé lowercase+trim
  delivered: boolean;
  clicks: number;            // clics distincts
  bounced: boolean;
  lastEventAt: Date | null;
}

interface TunnelScore {
  email: string;
  score: number;             // 0-100
  label: 'froid' | 'tiede' | 'chaud';
  disqualified: boolean;     // bounce
  lastSignalAt: Date | null;
  components: Record<string, number>; // détail des points (audit Twenty)
}

/** Fonction PURE : (signals, aggregates|null si non-consentant) → score. */
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
- Timeline → `POST /rest/batch/timelineActivities` (60/call, ≤100 req/min),
  noms namespacés : `email.sent|delivered|clicked|bounced|unsubscribed`,
  `audit.page_view|scroll|cta_click|rdv`. **Digests/jalons uniquement,
  jamais le flux brut.**
- Le flag `disqualified` (hard bounce) se matérialise par
  `doNotContact=true` sur la Person (registre = Twenty, §4c.5) — posé
  aussi sur `email.unsubscribed`.
- Stages : `SCREENING` posé sur `email.sent` si stage=NEW ; un stage ne
  recule JAMAIS automatiquement (§4c.6).

## 5. Ce qui reste TBD (hors de ce doc)

- Spec API entrante / modèle d'état / déploiement du réconciliateur :
  architecte (#17). Ce doc fournit le cœur scoring, transportable tel quel.
- Enforcement suppression-list côté Notifuse à l'envoi (au-delà du registre
  doNotContact Twenty) : à instruire avant le bulk, vérifié au gate #11.
