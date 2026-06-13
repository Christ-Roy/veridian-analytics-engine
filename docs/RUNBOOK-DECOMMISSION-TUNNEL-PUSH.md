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

### Les deux options propres (à trancher AVANT la coupure)

| Option | Description | Coût | Risque | Reco |
|---|---|---|---|---|
| **A — Scoring reste dans le micro-service** | Le natif ne pousse vers Twenty QUE les **jalons timeline** `audit.*` (fonction #3). Le **scoring unifié reste dans le micro-service** (fonction #4 + #5). Mais le bridge n'a plus le pull analytics → il lui faut les agrégats analytics par une **autre voie**. → Le natif émet AUSSI un webhook *vers le bridge* (pas vers Twenty) avec l'agrégat analytics par identité, OU l'engine expose un endpoint `GET /api/tunnel/aggregate?user_id=` que le bridge interroge à la place du pull brut. | Moyen — le natif doit fournir les agrégats au bridge | Faible — le scoring reste centralisé, une seule écriture `person.score` | ✅ **~75%** — préserve l'invariant scoring unifié sans dédoubler la logique |
| **B — Scoring migré dans l'engine** | Le natif calcule le **score complet** côté engine (re-implémente `score-tunnel.ts`) MAIS il a besoin des signaux Notifuse, que l'engine n'a pas. → L'engine devrait consommer les webhooks Notifuse OU le bridge pousse ses signaux Notifuse vers l'engine. Duplication de la logique de scoring + l'engine devient dépendant de Notifuse (couplage qu'on ne veut pas). | Élevé — re-implémentation + nouveau couplage engine↔Notifuse | Élevé — deux implémentations de scoring à garder synchro, couplage indésirable | ❌ contraire à « zéro code partagé » et au périmètre engine |

**Recommandation forte : Option A.** Le scoring unifié **reste l'autorité du
micro-service** (il a déjà les signaux Notifuse + le writer + le CAS
exactly-once sur `person.score`). Le natif ne fait que **remplacer le transport
de la source analytics** : au lieu d'un pull brut `export.userEvents`, il pousse
les jalons `audit.*` en timeline **et** alimente le bridge en agrégats analytics
(par identité) pour le recalcul de score.

> ⚠️ **GATE DE CONCEPTION** : ce runbook ne peut pas figer l'option tant que le
> connecteur natif (task #2) n'est pas conçu. **L'agent qui construit le natif
> (#2) DOIT trancher A vs B et le documenter dans `CONTRATS-TUNNEL.md` §7 (ou un
> §7b nouveau) AVANT la phase E2E (#3).** Le présent runbook recommande A et
> liste, en §3, les invariants que TOUTE option doit respecter.

---

## 3. Invariants à préserver (quelle que soit l'option retenue)

La coupure n'est **propre** que si, après bascule, TOUS ces invariants tiennent :

1. **Zéro perte d'event analytics.** Tout jalon `audit.*` qui partait via le
   pull horaire doit continuer d'arriver dans la timeline Twenty (via le natif).
2. **Zéro doublon timeline.** Les `eventId` doivent rester déterministes et
   uniques. Le micro-service utilisait `analytics:<identity>:<milestone>`
   (`analytics-pull.ts:emitMilestones`). Le natif **doit produire la même clé de
   dédup** (ou Twenty doit dédupliquer sur cette clé) — sinon re-jouer = doublon.
3. **Le scoring unifié reste correct.** `person.score` doit refléter
   Notifuse + Analytics. Pas de score analytics-only qui écrase le composant
   email. Invariant « 2 clics = 30 = chaud » vérifié post-bascule.
4. **Une seule autorité d'écriture sur `person.score`.** Pas deux writers qui se
   marchent dessus (lost update). Le CAS exactly-once du store
   (`markScorePushed` avec `AND score = ?`) ne protège QUE le writer du bridge —
   il ne protège PAS contre un second writer externe.
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

- [ ] Connecteur natif construit (task #2) + **option A/B tranchée et écrite**
      dans `CONTRATS-TUNNEL.md`.
- [ ] E2E natif vert (task #3) sur workspace Twenty de **TEST** (Tunnel Lab).
- [ ] Natif déployé en **prod** et tournant.
- [ ] Critères de **PREUVE PROD §5 TOUS verts**.

### Phase 1 — Double-run / parité (observation, ZÉRO coupure)

Le natif et le micro-service tournent **en parallèle** un temps donné (§5).
Pendant cette fenêtre :

- [ ] Le natif pousse les jalons analytics (vers Twenty et/ou vers le bridge
      selon l'option A).
- [ ] Le micro-service **continue** son pull analytics (rien coupé).
- [ ] On **compare** : mêmes jalons, mêmes timestamps, même score résultant.
      La dédup déterministe (§3.2) garantit que le double-run ne crée **pas** de
      doublon en timeline (même `eventId` → no-op).
- [ ] Tableau de parité tenu (cf §5) : 0 écart pendant N jours.

> ⚠️ Si l'option A est retenue et que le natif alimente le bridge en agrégats,
> la Phase 1 vérifie aussi que le bridge sait consommer cette nouvelle voie
> **en plus** de son pull (les deux donnent le même agrégat).

### Phase 2 — Coupure de la source analytics du micro-service

Côté **micro-service** (`veridian-tunnel-de-vente`), une fois la parité prouvée :

- [ ] **Désactiver les étapes 1+2 de `sync.runOnce()`** (pull export + emit
      jalons). Voie propre : un flag `ANALYTICS_PULL_ENABLED` (défaut `1`) qui,
      à `0`, saute le bloc `if (engineAdminEmail && engineAdminPassword)` dans
      `sync.ts`. **NE PAS supprimer le code** en Phase 2 (rollback instantané).
- [ ] Retirer (ou laisser vides) les ENV `ENGINE_ADMIN_EMAIL` /
      `ENGINE_ADMIN_PASSWORD` du compose bridge → le pull ne s'arme plus de
      lui-même (le code skippe déjà si elles sont vides : `sync.ts` L74).
      ⚠️ **Garder** `ENGINE_BASE_URL`/`ENGINE_WORKSPACE_ID` si l'option A fait
      que le bridge interroge encore l'engine pour les agrégats.
- [ ] **Garder** le scoring (#4) et le writer (#5) — ils tournent toujours,
      alimentés par les signaux Notifuse + (option A) les agrégats analytics
      fournis par le natif.
- [ ] Redéployer le bridge sur dev-pub (`docker compose up -d`).
- [ ] Vérifier `GET https://bridge.staging.veridian.site/healthz` : `ok`,
      `last_sync_at` continue d'avancer (sweep Notifuse tourne toujours).

### Phase 3 — Vérification post-coupure (fenêtre d'observation)

- [ ] Pendant 48-72h, vérifier que les jalons `audit.*` arrivent **toujours**
      dans Twenty (via le natif désormais) — zéro régression timeline.
- [ ] Vérifier que les scores restent cohérents (invariant §3.3).
- [ ] Vérifier les logs bridge : plus de ligne `[sync] pulled=...` (ou
      `pulled=0`), le sweep Notifuse continue (`réinjectés=...`).
- [ ] Vérifier la CI E2E tunnel (`tunnel-e2e.yml`) reste **verte** — elle
      exerce le parcours complet ; adapter les gates analytics si elles
      testaient le pull (cf ticket §6, point « adapter tunnel-e2e »).

### Phase 4 — Nettoyage (après fenêtre d'observation stable)

- [ ] Supprimer le code mort du pull analytics du micro-service
      (`analytics-pull.ts`, `engine-client.ts`, étapes 1-2 de `sync.ts`) — tier
      🟡, l'agent tunnel promote autonome après E2E vert.
- [ ] Mettre à jour `CONTRATS-TUNNEL.md` §7 : le flux analytics est désormais
      natif engine→Twenty ; le micro-service ne couvre plus que Notifuse (+ lane
      segments). Historiser la bascule (date, SHA).
- [ ] Mettre à jour `DEFINITION-OF-DONE-V1.md` et la doc SPEC-BRIDGE si elle
      décrit encore le pull analytics comme à la charge du bridge.

---

## 5. Critères de PREUVE PROD — go / no-go de la coupure

🔴 **AUCUNE coupure (Phase 2) tant que ces critères ne sont pas TOUS verts.**

| # | Critère | Mesure | Seuil go |
|---|---|---|---|
| P1 | **Natif tourne en prod sans erreur** | `webhook_deliveries.status` du connecteur Twenty natif | **≥ 7 jours** consécutifs, taux `success` **≥ 99%**, zéro `gave_up` non justifié |
| P2 | **Parité timeline** | Diff jalons `audit.*` poussés par le natif vs ceux qui seraient poussés par le pull (double-run Phase 1) | **0 écart** sur la fenêtre (mêmes events, mêmes happensAt, mêmes targetPerson) |
| P3 | **Parité scoring** | `person.score` calculé avec source natif == score historique (mêmes composants Notifuse+Analytics) | **0 écart** ; invariant « 2 clics = 30 = chaud » re-vérifié |
| P4 | **Zéro doublon** | Re-jouer un parcours → `eventId` déterministe → no-op en timeline | **0 doublon** créé par le double-run |
| P5 | **Zéro perte** | Tout `audit.*` vu côté engine arrive côté Twenty (compteur source vs destination) | **0 perte** sur la fenêtre |
| P6 | **Latence acceptable** | délai event analytics → apparition Twenty via natif | meilleure ou égale au pull horaire (≤ 1h, idéalement temps réel) |
| P7 | **Flux Notifuse non impacté** | webhook + sweep Notifuse continuent, `healthz` ok | aucune régression observée pendant la fenêtre |
| P8 | **Option A/B figée au contrat** | `CONTRATS-TUNNEL.md` §7 documente la nouvelle topologie + autorité du score | présent et relu |

**Rollback (si un critère casse après Phase 2)** : remettre
`ANALYTICS_PULL_ENABLED=1` (+ ENV `ENGINE_ADMIN_*`), redéployer le bridge → le
pull analytics reprend immédiatement. La dédup déterministe absorbe le
recouvrement. C'est pourquoi **on ne supprime AUCUN code avant la Phase 4**.

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
