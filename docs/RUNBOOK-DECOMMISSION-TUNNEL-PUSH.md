# Runbook — Débrancher le push analytics→Twenty du micro-service tunnel

> **But** : couper **proprement** la partie **analytics→Twenty** du micro-service
> réconciliateur `veridian-tunnel-de-vente/bridge` une fois que le **connecteur
> Twenty natif** de l'engine (module `webhooks`, design B) est **prouvé en prod**.
>
> **Owner runbook** : agent `veridian-analytics-engine` (decommission).
> **Exécutant de la coupure** : agent `veridian-tunnel-de-vente` (via le ticket
> `todo/2026-06-13-debrancher-push-analytics-twenty.md` déposé dans son repo).
> **Créé** : 2026-06-13.
>
> 🔴 **NE RIEN COUPER tant que les critères de PREUVE PROD (§5) ne sont pas TOUS
> verts.** Ce runbook est une préparation. La coupure est conditionnée.
>
> 🔴 **Périmètre STRICT : on coupe UNIQUEMENT le flux analytics→Twenty.** Le
> micro-service reste vivant — il porte la partie Notifuse→Twenty (qui RESTE) et
> a même un futur élargi (lane segments §D du giga-ticket cold-call). Ce n'est
> **PAS** un kill du service.

---

## 0. TL;DR — la décision en une phrase

Le micro-service tunnel est un **réconciliateur COMMUN Notifuse + Analytics**
(`CONTRATS-TUNNEL.md` §7). Le connecteur natif de l'engine ne remplace QUE la
**source analytics** (le `pull export.userEvents`). Tout le reste du
micro-service — webhook Notifuse, sweep Notifuse, **writer Twenty**, **scoring
unifié** — **reste en service**. Le débranchement consiste à **désactiver les
étapes 1+2 du `sync.runOnce()`** (pull analytics + emit jalons) une fois que
l'engine pousse ces mêmes jalons nativement, **sans casser le scoring unifié ni
le flux Notifuse**.

> ✅ **OPTION A FIGÉE (team-lead, 2026-06-13).** L'engine **ne calcule JAMAIS** et
> **ne PATCH JAMAIS** `person.score`. Le **bridge reste la seule autorité du
> score** (il a les signaux Notifuse + le writer + le CAS exactly-once). L'engine
> fournit deux choses, et deux seulement : **(a)** la timeline analytics
> event-driven (jalons `audit.*`, team task #2) et **(b)** un **endpoint
> d'agrégats analytics** `GET /api/tunnel.aggregate` que le bridge consomme
> **à la place du pull brut** pour fusionner avec ses signaux Notifuse (team task
> #5 reformulé). La variante « engine PATCH score » de l'option B est **écartée**.
> Le contrat exact de l'endpoint (shape = interface `AnalyticsAggregate`) est en
> §2bis et doit être figé dans `CONTRATS-TUNNEL.md` §7 **avant l'E2E #3**.

---

## 1. Cartographie — ce que fait le micro-service (5 fonctions)

Audit du code `veridian-tunnel-de-vente/bridge/src/` au 2026-06-13 :

| # | Fonction | Fichier(s) | Source | Sort | Statut décommission |
|---|---|---|---|---|---|
| 1 | **Webhook Notifuse entrant** (HMAC, dédup, store `email.*`) | `server.ts` `/webhooks/notifuse` | Notifuse | events store | ✅ **RESTE** (Notifuse) |
| 2 | **Sweep Notifuse** (`messages.list?updated_after`, filet anti-perte) | `sync.ts:sweepNotifuse` | Notifuse | events store | ✅ **RESTE** (Notifuse) |
| 3 | **Pull Analytics** (`export.userEvents` → agrégats + jalons `audit.*`) | `analytics-pull.ts`, `engine-client.ts`, `sync.ts` étapes 1-2 | Analytics engine | jalons store + agrégats | ❌ **REMPLACÉ** par le natif |
| 4 | **Scoring unifié** (`computeTunnelScore(notifuse, analytics)`) | `score-tunnel.ts`, `sync.ts:computeScores` | **Notifuse + Analytics** | score + label Person | ⚠️ **MIXTE** — voir §2 (décision critique) |
| 5 | **Writer Twenty** (batch timeline, PATCH score, stage NEW→SCREENING, doNotContact) | `writer.ts` | store (tous events) | Twenty | ✅ **RESTE** (voie d'écriture commune) |

### Ce que le natif (design B) remplace exactement

Le module `webhooks` de l'engine (`api/src/webhooks/`) émet `event.tracked`
après chaque insert ClickHouse → `WebhookDispatcherService` matche les webhook
definitions actives → enqueue une delivery → le worker POST vers Twenty (auth
HMAC/Bearer, transform handlebars, retry). Le **connecteur Twenty natif**
(team task #2) est une webhook definition (+ logique de scoring/jalons côté
engine) pointant vers Twenty.

**Il remplace strictement la fonction #3** : au lieu que le micro-service
**pull** `export.userEvents` toutes les heures et calcule les jalons `audit.*`,
c'est l'engine qui **push** ces jalons en temps réel vers Twenty. Les jalons
analytics figés `CONTRATS-TUNNEL.md` §4c.3 (`audit.page_view`, `audit.scroll`,
`audit.cta_click`, `audit.rdv`, `signup`, `app.started`) sont les mêmes — seul
le **transport** change (pull horaire → push événementiel).

### Ce qui ne bouge PAS

- **Tout le flux Notifuse** (#1, #2) : Notifuse émet des webhooks signés, le
  micro-service les reçoit et les écrit. L'engine n'a **rien à voir** avec
  Notifuse (ce n'est pas sa data). Toucher à ça = hors périmètre, **interdit**.
- **Le writer Twenty** (#5) reste la voie d'écriture du micro-service pour les
  events Notifuse. Si demain le natif écrit AUSSI directement dans Twenty, on a
  **deux writers** sur la même Person/timeline → idempotence à garantir (§3).

---

## 2. Décision de conception critique — le scoring est UNIFIÉ

**C'est le point qui rend ce débranchement non-trivial.** Ne pas le rater.

`computeTunnelScore(notifuse, analytics)` (`score-tunnel.ts`) calcule **un seul
score par Person en fusionnant les deux familles de signaux** :

- Famille **Notifuse** : `email_opened` (+5), `email_clicks` (+20..+40).
- Famille **Analytics** : `audit_view` (+10), `audit_scroll` (+15),
  `hot_pages` (+15..+30), `cta_click` (+20), `identify_email` (+35),
  `app_started` (+40), `rdv_booked` (+50), `return_visit` (+15).
- Multiplicateur de récence ×1.5, cap 100, seuil chaud ≥30.

Invariant lead figé : « 2 clics email = 30 = chaud » **doit survivre** même
sans aucun signal analytics (non-consentants cookies). Le score est donc
**intrinsèquement cross-source**.

### Le piège à éviter absolument

❌ **Ne PAS** laisser le natif pousser un score *analytics-only* dans le champ
`person.score` de Twenty. Il écraserait les composants Notifuse → un prospect
qui a cliqué 2 mails mais n'a pas (encore) de cookies analytics retomberait à 0
= **régression de scoring + perte de leads chauds**.

### Décision figée : Option A (team-lead, 2026-06-13)

| Option | Description | Statut |
|---|---|---|
| **A — Scoring reste dans le micro-service** | Le natif ne pousse vers Twenty QUE les **jalons timeline** `audit.*` (remplace la fonction #3 côté timeline). Le **scoring unifié reste dans le micro-service** (fonctions #4 + #5). Le bridge n'a plus le pull brut → l'engine lui expose un **endpoint d'agrégats analytics** `GET /api/tunnel.aggregate` (cf §2bis) que le bridge consomme à la place de `export.userEvents`, puis fusionne avec ses signaux Notifuse. | ✅ **RETENUE** — préserve l'invariant scoring unifié, une seule autorité `person.score`, pas de couplage engine↔Notifuse |
| **B — Scoring migré dans l'engine (engine PATCH score)** | Le natif recompute et PATCH `person.score` côté engine. Mais l'engine n'a pas les signaux Notifuse (et ne doit pas — couplage interdit) → score analytics-only qui écrase les composants email + double writer sur `person.score`. | ❌ **ÉCARTÉE** — régression scoring garantie + lost update |

**Conséquence directe pour le débranchement** : une seule chose est coupée côté
bridge — le **pull brut** `export.userEvents` (la consommation passive de
`analytics-pull.ts` + `engine-client.ts`). Il est **remplacé par la consommation
de l'endpoint agrégat**. Le scoring (#4), le writer (#5), le flux Notifuse (#1,
#2) **restent intégralement côté bridge**. L'engine **ne touche jamais** au champ
`person.score`.

---

## 2bis. Contrat de l'endpoint agrégat `GET /api/tunnel.aggregate`

> 🔴 À **figer dans `CONTRATS-TUNNEL.md` §7 AVANT l'E2E #3.** C'est le contrat
> qui remplace le pull brut côté bridge. Tranché par l'agent qui porte les tasks
> #2/#5 (twenty-connector) ; ce runbook fixe la cible que le bridge attend.

- **Auth** : JWT super-admin engine (`auth.login` programmatique, déjà en place
  pour le pull — `CONTRATS-TUNNEL.md` §7 « auth réconciliateur »). Pas d'API key
  workspace possible sur un workspace platform-managed (403 vérifié 2026-06-10).
- **Query** : `workspace_id` (= `vrd_veridian_site_prod`), `since` / `until`
  (fenêtre, défaut 48h pour coller au curseur actuel du bridge), pagination
  cursor pour les gros volumes.
- **Réponse** : un agrégat **par identité** (`user_id` = slug audit OU email
  normalisé), shape **strictement identique** à l'interface `AnalyticsAggregate`
  que `score-tunnel.ts` consomme aujourd'hui — sinon le bridge doit re-mapper et
  on introduit un risque de drift :

```ts
// shape attendue par item (1 par user_id) — miroir de AnalyticsAggregate
{
  userId: string;          // slug audit OU email normalisé (union des 2 clés)
  auditViews: number;
  auditScrollMax: number;  // 0-100
  hotPages: number;        // /tarifs, /contact, /roi (uniques)
  otherPages: number;      // hors audit + hors chaudes (uniques)
  consented: boolean;      // tracké, ne score JAMAIS (décision lead)
  ctaClicks: number;
  rdvBooked: number;
  identifiedByEmail: boolean;
  appStarted: boolean;     // goal Hub notifuse/prospection (whitelist §4a-bis)
  sessions: number;
  lastSeen: string | null; // ISO 8601 (le bridge parse en Date)
}
```

- **Sémantique d'agrégation** : exactement celle de `analytics-pull.ts:aggregateEvents`
  (SCORING-V1.md §3) — c'est l'engine qui devient la source de vérité de
  l'agrégat, donc l'engine doit reproduire fidèlement cette agrégation
  (HOT_PATHS, mapping des goals `audit.*`/`signup`/`app_started`, whitelist
  `APP_STARTED_SCORED_APPS`, `consent_granted` = 0 point). Tout écart = écart de
  score → bloquant en parité (§5 P3).
- **Le bridge garde** la fusion slug↔email (`mergeAggregates` via `links.json`)
  et le calcul `computeTunnelScore(notifuse, analytics)`. L'endpoint ne remplace
  QUE la **source** des agrégats analytics, pas la logique de score.

---

## 3. Invariants à préserver (Option A)

La coupure n'est **propre** que si, après bascule, TOUS ces invariants tiennent :

1. **Zéro perte d'event analytics.** Tout jalon `audit.*` qui partait via le
   pull horaire doit continuer d'arriver dans la timeline Twenty (via le natif).
2. **Zéro doublon timeline.** Les `eventId` doivent rester déterministes et
   uniques. Le micro-service utilisait `analytics:<identity>:<milestone>`
   (`analytics-pull.ts:emitMilestones`). Le natif **doit produire la même clé de
   dédup** (ou Twenty doit dédupliquer sur cette clé) — sinon re-jouer = doublon.
3. **Le scoring unifié reste correct.** `person.score` doit refléter
   Notifuse + Analytics. L'engine ne PATCH JAMAIS `person.score` (Option A) ; le
   bridge recompute depuis l'endpoint agrégat + ses signaux Notifuse. Invariant
   « 2 clics = 30 = chaud » vérifié post-bascule.
4. **Une seule autorité d'écriture sur `person.score` = le bridge.** L'engine ne
   touche jamais ce champ (Option A figée). Le CAS exactly-once du store
   (`markScorePushed` avec `AND score = ?`) reste l'unique garde-fou — il n'y a
   pas de second writer externe à craindre tant que l'Option A tient.
4bis. **L'agrégat servi par l'endpoint == l'agrégat produit par le pull.** La
   sémantique d'agrégation engine doit être identique à `aggregateEvents`
   (§2bis) — sinon écart de score (bloquant en parité §5 P3).
5. **happensAt = vraie heure de l'event** (`CONTRATS-TUNNEL.md` §4c.2), pas
   l'heure de livraison. Le micro-service normalisait en `toISOString()`
   (Twenty rejette les micro-précisions en 400 → casse le batch de 60).
6. **Le flux Notifuse intact.** Webhook entrant + sweep + écriture Notifuse
   continuent de tourner exactement comme avant. Aucune ENV Notifuse retirée.
7. **stage NEW→SCREENING + doNotContact** (déclenchés par events Notifuse,
   `writer.ts`) restent fonctionnels — ils dépendent du writer #5 qui RESTE.

---

## 4. Procédure de bascule (ordre, par phases)

> Exécutée par l'agent `veridian-tunnel-de-vente` côté micro-service + l'agent
> engine côté natif. Coordination via le team-lead.

### Phase 0 — Pré-requis (bloquants)

- [ ] Connecteur natif timeline construit (task #2).
- [ ] **Endpoint agrégat `GET /api/tunnel.aggregate` livré** (task #5) + contrat
      §2bis **figé dans `CONTRATS-TUNNEL.md` §7**.
- [ ] **Bridge adapté** pour consommer l'endpoint agrégat à la place du pull brut
      (ticket tunnel §3) — capable des deux voies en Phase 1.
- [ ] E2E natif vert (task #3) sur workspace Twenty de **TEST** (Tunnel Lab).
- [ ] Natif déployé en **prod** et tournant.
- [ ] Critères de **PREUVE PROD §5 TOUS verts**.

### Phase 1 — Double-run / parité (observation, ZÉRO coupure)

Le natif et le micro-service tournent **en parallèle** un temps donné (§5).
Pendant cette fenêtre :

- [ ] Le natif pousse les jalons `audit.*` en timeline Twenty (task #2).
- [ ] Le micro-service **continue** son pull analytics brut (rien coupé).
- [ ] **L'endpoint agrégat tourne** ; on compare l'agrégat servi par
      `GET /api/tunnel.aggregate` avec l'agrégat que le bridge produit par son
      pull (`aggregateEvents`) — **item par item, champ par champ** : 0 écart.
- [ ] On **compare** : mêmes jalons timeline, mêmes timestamps, même score
      résultant. La dédup déterministe (§3.2) garantit que le double-run ne crée
      **pas** de doublon en timeline (même `eventId` → no-op).
- [ ] Le bridge sait consommer la **nouvelle voie agrégat** en plus de son pull
      (les deux donnent le même `AnalyticsAggregate`) — c'est ce qui autorise la
      bascule de source en Phase 2.
- [ ] Tableau de parité tenu (cf §5) : 0 écart pendant N jours.

### Phase 2 — Bascule de la source analytics (pull brut → endpoint agrégat)

Côté **micro-service** (`veridian-tunnel-de-vente`), une fois la parité prouvée.
⚠️ **On ne coupe PAS l'apport analytics du scoring** — on en change la SOURCE :
le bridge cesse de pull `export.userEvents` (+ emit jalons timeline, désormais
faits par le natif) et lit l'endpoint agrégat pour le recalcul de score.

- [ ] **Basculer la source** : `sync.ts` consomme `GET /api/tunnel.aggregate`
      au lieu de `exportAll` + `aggregateEvents`, et **n'émet plus** les jalons
      timeline `audit.*` (le natif les pousse). Voie propre : flag
      `ANALYTICS_SOURCE` (`pull` par défaut → `aggregate`) qui choisit la source.
      **NE PAS supprimer le code du pull** en Phase 2 (rollback instantané).
- [ ] **Garder armé l'accès engine** : `ENGINE_ADMIN_EMAIL`/`ENGINE_ADMIN_PASSWORD`
      (JWT super-admin) + `ENGINE_BASE_URL`/`ENGINE_WORKSPACE_ID` — l'endpoint
      agrégat utilise la **même auth** que le pull. **Ne PAS vider ces ENV.**
- [ ] **Garder** le scoring (#4) et le writer (#5) — ils tournent toujours,
      alimentés par les signaux Notifuse + les agrégats analytics servis par
      l'endpoint engine. L'engine ne touche JAMAIS `person.score`.
- [ ] Redéployer le bridge sur dev-pub (`docker compose up -d`).
- [ ] Vérifier `GET https://bridge.staging.veridian.site/healthz` : `ok`,
      `last_sync_at` continue d'avancer (sweep Notifuse + recalcul score tournent).

### Phase 3 — Vérification post-coupure (fenêtre d'observation)

- [ ] Pendant 48-72h, vérifier que les jalons `audit.*` arrivent **toujours**
      dans Twenty (via le natif désormais) — zéro régression timeline.
- [ ] Vérifier que les scores restent cohérents (invariants §3.3 / §3.4bis) —
      le bridge recompute toujours `person.score`, alimenté par l'endpoint.
- [ ] Vérifier les logs bridge : plus de ligne `[sync] pulled=...` brut (la
      source agrégat remplace), le sweep Notifuse continue (`réinjectés=...`),
      les scores continuent d'être upsert/poussés.
- [ ] Vérifier la CI E2E tunnel (`tunnel-e2e.yml`) reste **verte** — elle
      exerce le parcours complet ; adapter les gates analytics si elles
      testaient le pull brut (cf ticket §6, point « adapter tunnel-e2e »).

### Phase 4 — Nettoyage (après fenêtre d'observation stable)

- [ ] Supprimer le code mort du **pull brut** analytics du micro-service
      (`engine-client.ts:exportAll`, `analytics-pull.ts:aggregateEvents` +
      `emitMilestones` si le natif fait la timeline, étapes pull de `sync.ts`) —
      tier 🟡, l'agent tunnel promote autonome après E2E vert.
      ⚠️ **Garder** `score-tunnel.ts`, `writer.ts`, `mergeAggregates`, et le
      client de l'endpoint agrégat — ils restent l'autorité du score.
- [ ] Mettre à jour `CONTRATS-TUNNEL.md` §7 : la timeline analytics est désormais
      native engine→Twenty ; l'agrégat analytics est servi par
      `GET /api/tunnel.aggregate` (contrat §2bis figé) ; le bridge reste seule
      autorité du `person.score`. Historiser la bascule (date, SHA).
- [ ] Mettre à jour `DEFINITION-OF-DONE-V1.md` et la doc SPEC-BRIDGE si elle
      décrit encore le pull brut analytics comme à la charge du bridge.

---

## 5. Critères de PREUVE PROD — go / no-go de la coupure

🔴 **AUCUNE coupure (Phase 2) tant que ces critères ne sont pas TOUS verts.**

| # | Critère | Mesure | Seuil go |
|---|---|---|---|
| P1 | **Natif tourne en prod sans erreur** | `webhook_deliveries.status` du connecteur Twenty natif | **≥ 7 jours** consécutifs, taux `success` **≥ 99%**, zéro `gave_up` non justifié |
| P2 | **Parité timeline** | Diff jalons `audit.*` poussés par le natif vs ceux qui seraient poussés par le pull (double-run Phase 1) | **0 écart** sur la fenêtre (mêmes events, mêmes happensAt, mêmes targetPerson) |
| P3a | **Parité agrégat** | agrégat servi par `GET /api/tunnel.aggregate` == agrégat produit par `aggregateEvents` du pull (item/champ) | **0 écart** sur la fenêtre |
| P3b | **Parité scoring** | `person.score` recomputé bridge depuis l'endpoint == score historique (mêmes composants Notifuse+Analytics) | **0 écart** ; invariant « 2 clics = 30 = chaud » re-vérifié |
| P4 | **Zéro doublon** | Re-jouer un parcours → `eventId` déterministe → no-op en timeline | **0 doublon** créé par le double-run |
| P5 | **Zéro perte** | Tout `audit.*` vu côté engine arrive côté Twenty (compteur source vs destination) | **0 perte** sur la fenêtre |
| P6 | **Latence acceptable** | délai event analytics → apparition Twenty via natif | meilleure ou égale au pull horaire (≤ 1h, idéalement temps réel) |
| P7 | **Flux Notifuse non impacté** | webhook + sweep Notifuse continuent, `healthz` ok | aucune régression observée pendant la fenêtre |
| P8 | **Contrat endpoint figé** | `CONTRATS-TUNNEL.md` §7 documente `GET /api/tunnel.aggregate` (shape §2bis) + autorité du score = bridge (Option A) | présent et relu |
| P9 | **Engine ne PATCH jamais `person.score`** | audit des écritures Twenty : aucune mutation `person.score` ne provient de l'engine | confirmé (Option A respectée) |

**Rollback (si un critère casse après Phase 2)** : remettre `ANALYTICS_SOURCE=pull`
(les ENV `ENGINE_ADMIN_*` n'ont jamais été retirées), redéployer le bridge → le
pull brut analytics reprend immédiatement comme source de score. La dédup
déterministe absorbe le recouvrement timeline. C'est pourquoi **on ne supprime
AUCUN code avant la Phase 4**.

---

## 6. Ticket déposé chez l'agent tunnel

`veridian-tunnel-de-vente/todo/2026-06-13-debrancher-push-analytics-twenty.md`
détaille la part **côté micro-service** (quoi couper #3, quoi garder #1/#2/#4/#5,
flag de bascule, adaptation `tunnel-e2e`, vérif zéro régression). Ce runbook =
la vue **côté engine** + la coordination. Les deux se référencent.

---

## 7. Ce que ce runbook NE fait PAS

- ❌ Il ne coupe rien. La coupure est gatée par §5 + le go du team-lead.
- ❌ Il ne touche pas au code du micro-service (autre repo, autre agent → ticket).
- ❌ Il ne touche **jamais** au flux Notifuse→Twenty (hors périmètre, RESTE).
- ❌ Il ne supprime pas le micro-service (il garde un rôle Notifuse + segments).
