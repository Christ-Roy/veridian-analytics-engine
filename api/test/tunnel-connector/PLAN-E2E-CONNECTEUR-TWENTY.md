# Plan de test E2E — Connecteur Twenty natif (design B)

> Auteur : agent `e2e-prove` (team `webhooks-twenty-native`)
> Statut : **préparé** (Task #3 bloquée par #2 — connecteur pas encore livré)
> Cible figée : prouver, sur staging RÉEL, que la data analytics arrive NICKEL
> dans Twenty via le connecteur natif du module `api/src/webhooks/`.
> Référentiels : `CONTRATS-TUNNEL.md §4`, `TUNNEL-IDENTITE.md`,
> `SPEC-BRIDGE-TUNNEL.md §4c/§6`, `PATTERNS-WEBHOOKS.md`, `DEFINITION-OF-DONE-V1.md §1.3`.

---

## 0. Compréhension de l'architecture (design A → design B)

**Design A (ancien, à débrancher — Task #4)** : micro-service `bridge` externe
sur dev-pub (`veridian-tunnel-de-vente/bridge/` + dossier `veridian-bridge/`
dans l'engine + `ANALYTICS_ENGINE_STAGING_BRIDGE_URL`). Notifuse pousse ses
webhooks dessus, et le bridge PULL l'engine + écrit Twenty.

**Design B (cible)** : le module webhooks **natif de l'engine**
(`api/src/webhooks/`, déjà en prod : CRUD + dispatcher `@OnEvent('event.tracked')`
+ delivery worker `@Interval(10s)` + SSRF + crypto AES-256-GCM + transform
handlebars + deliveries dans ClickHouse `staminads_system.webhook_deliveries`)
gagne un **connecteur Twenty natif** : une destination de type `twenty` qui,
au lieu d'un POST handlebars générique, fait DIRECTEMENT le travail du §4c :
- résout la Person (par `auditSlug` pour events analytics, par email normalisé
  pour events identify),
- mappe les goal names bruts → digests timeline namespace.verbe (§4c.3),
- POST `timelineActivities` (happensAt = vraie heure de l'event),
- PATCH `person.score` + `components`,
- pose `doNotContact=true` sur unsubscribe,
- dédup par `event_id` (= `dedup_token` émis par `emitTracked`) → idempotence.

Le connecteur EST le writer unique vers Twenty (invariant §4c : une seule voie
d'écriture). Le `webhook_deliveries` du module joue le rôle du store d'état
(idempotence + traçabilité + latence).

## 1. Chaîne prouvée de bout en bout

```
POST /api/track (staging engine, public)
  → SessionPayloadHandler.handle → buffer ClickHouse
  → emitTracked → EventEmitter2 'event.tracked' (event_id = dedup_token)
  → WebhookDispatcher : match filtres + events du webhook tunnel
  → enqueueDelivery → row webhook_deliveries status=pending
  → WebhookDeliveryWorker (@Interval 10s) : connecteur Twenty
  → résolution Person (auditSlug|email) → POST timelineActivities + PATCH score
  → row webhook_deliveries status=success, latency_ms, http_status=200|201
  → DANS Twenty : timeline du prospect + score à jour
```

## 2. Cibles de test (workspaces RÉELS)

| Rôle | Workspace analytics (engine) | Workspace Twenty (CRM) |
|---|---|---|
| **Tenant A (primaire)** | `vrd_veridian_site_staging` | **REPLAY** `f7e83cd3-d1d2-4420-bde5-e9e8471e1649` (`veridian-3wm3l1xq`) |
| **Tenant B (isolation)** | (2e workspace de test à provisionner, ex `vrd_e2etestb_staging`) | **Lab** `183e4654-...` (`veridian-od8jidsl`) |

**Choix REPLAY comme cible primaire (tranché par e2e-prove)** : c'est le SEUL
workspace Twenty qui a la structure tunnel COMPLÈTE appliquée par
`twenty-iac.py apply` — `person` étendu avec `score` NUMBER, `auditSlug` TEXT,
`providerClass` SELECT (GOOGLE/MICROSOFT/YAHOO_AOL/FREEMAIL_FR/CORPORATE),
`doNotContact` BOOL, `isTestProspect` BOOL, relation `mailingBatch` + objets
custom `coldProspect`/`mailingBatch` + vues Kanban. Vérifié 2026-06-13 via
`GET /rest/metadata/objects`.

⚠️ **Le workspace Lab N'A PAS** les fields tunnel sur `person` (seulement le
custom object `coldProspect` cold-call). Donc le Lab ne sert QU'À l'isolation
multi-tenant (tenant B), PAS à prouver la data tunnel. Tester le connecteur
contre le Lab donnerait des PATCH score en 400 (field inexistant) = faux rouge.

Creds : `~/credentials/.all-creds.env` →
`TWENTY_BEARER_TUNNEL_REPLAY`, `TWENTY_BEARER_TUNNEL_LAB`,
`ANALYTICS_ENGINE_STAGING_VERIDIAN_ADMIN_API_KEY` (admin engine staging).

## 3. Pré-requis bloquants (à confirmer AVANT de lancer le run)

1. **Connecteur livré** (Task #2) : type `twenty` dispo dans le DTO webhook +
   logique writer dans le delivery worker. → signal de `twenty-connector`.
2. **Person de test seedées dans REPLAY** avec `auditSlug` + `emails` +
   `isTestProspect=true` (famille `test-tunnel-*` / `test-cycle-*` de la DoD
   §1.1). Le connecteur NE CRÉE JAMAIS de Person (§4c.2 / SPEC §4.2) — la
   résolution échoue en `orphan` si la Person n'existe pas. Donc on seed
   d'abord (idempotent, garde-fou `isTestProspect===true`).
3. **Webhook tunnel configuré** sur `vrd_veridian_site_staging` pointant le
   REPLAY (Bearer REPLAY chiffré). Auth des endpoints `webhooks.*` =
   `WorkspaceAuthGuard` → le workspace platform-managed n'a pas d'API key :
   il faudra soit le JWT super-admin, soit provisionner une API key, soit
   créer le webhook en seed côté ClickHouse. **À clarifier avec twenty-connector.**
4. **DRY_RUN OFF** pour l'écriture réelle (le gate accepte DRY_RUN d'abord pour
   le run à blanc, puis écriture réelle — SPEC §6.7).
5. **Aucun envoi de mail réel** (boîte Lark perso de Robert) : le parcours
   analytics ne déclenche aucun mail, OK ; tout flux Notifuse en test = sink /
   injection signée (DoD §2.4). Notre périmètre #3 = events ANALYTICS, pas mail.

---

## 4. Specs à prouver (vert/rouge, une par une)

### SPEC-1 — Webhook créé sur le workspace tunnel
- Créer (ou vérifier idempotent) un webhook destination `twenty` sur
  `vrd_veridian_site_staging` → REPLAY, events `[screen_view, goal]`,
  filtre `path matches ^/audit/`.
- **Vert si** : `webhooks.create` → 201 (ou `webhooks.list` montre le webhook
  existant), token Bearer REPLAY **masqué** dans la réponse (`has_secret:true`,
  jamais le token), `auth_secret` chiffré en DB.
- **Rouge si** : 401/403/500, ou token en clair dans la réponse/DB.
- ⚠️ **Lié Task #6** : `webhooks.create` avec champ `auth` absent/invalide doit
  renvoyer **400** (`INVALID_*`), PAS 500. À re-tester une fois #6 livrée
  (input malformé = erreur structurée que l'agent qui provisionne peut traiter).

### SPEC-2 — Parcours réaliste via POST /api/track
Séquence d'un prospect (script `parcours-events.mjs`), un seul `user_id` qui
bascule slug→email en cours de session (rétro-attribution staminads) :
1. `identify(slug)` → pageview `/audit/<slug>` (audit_view) — `user_id=slug`
2. scroll 75 sur la page audit (max_scroll porté par le pageview)
3. goal `audit_cta_rdv` / `cta_click {cta}` 
4. `identify(email)` → la suite de la session re-postée avec `user_id=email`
5. goal `rdv_booked`
- **Vert si** : chaque POST `/api/track` → 200 `{success:true}` ; les events
  arrivent dans ClickHouse (vérif via `export.userEvents?user_id=`).
- **Rouge si** : un POST != 200, ou un event manquant à l'export.

### SPEC-3 — Data NICKEL dans Twenty (cœur)

⚠️ **Architecture en 2 régimes (arbitrage lead, Tasks #2 vs #5)** :
- **TIMELINE = event-driven** → connecteur du delivery worker (Task #2).
  1 event → 1 timelineActivity, latence ~15s (tick worker 10s).
- **SCORE = agrégat** → service `@Interval` séparé `TwentyScoreSyncService`
  (Task #5). Le score est fonction de TOUT l'historique d'une identité
  (un webhook voit 1 event isolé sans l'historique) → recompute périodique +
  PATCH des écarts. La latence du score dépend de la période du job.
- **Conséquence test** : 3a/3b/3d/3e se prouvent après le tick worker (#2) ;
  3c (score) se prouve après un cycle du job @Interval (#5). Mon #3 est bloqué
  par #2 ET #5.

- **3a Résolution Person** : la timeline atterrit sur la BONNE Person (résolue
  par slug PUIS par email — les deux clés doivent converger sur le même record,
  union slug↔email). [via #2]
- **3b Noms d'events** : timeline contient les digests namespace.verbe du §4c.3
  (`audit.page_view`, `audit.scroll`, `audit.cta_click`, `audit.rdv`) — JAMAIS
  les goal names bruts du site (`cta_click`, `rdv_booked`...). Le connecteur
  fait le mapping. [via #2]
- **3c Score** : ⚠️ **l'engine NE PATCH PAS `person.score`** (pivot lead, cf
  SPEC-3bis). Le score reste écrit par le **bridge tunnel** (autorité unique,
  fusion Notifuse+analytics, compare-and-set). Ma vérif côté engine = assertion
  NÉGATIVE : aucune écriture engine sur `person.score`. La preuve du score
  correct (grille §4a, invariant "2 clics = 30") se fait côté bridge, hors de
  mon périmètre #3 — je vérifie seulement que l'engine fournit l'agrégat juste
  (SPEC-3bis) que le bridge consommera.
- **3d happensAt** : chaque `timelineActivity.happensAt` = la VRAIE heure de
  l'event (timestamp du goal/pageview, base ts figée du script), PAS l'heure
  d'écriture. [via #2]
- **3e Idempotence (ZÉRO doublon)** : **rejouer le MÊME parcours** (mêmes
  session_id + timestamps → mêmes `dedup_token` → mêmes `event_id`) ne crée
  AUCUNE nouvelle timelineActivity [#2] ni double-compte de score [#5].
  Comptage timeline AVANT == APRÈS le replay.

### SPEC-3bis — Endpoint agrégats analytics (Task #5, design final)

⚠️ **Pivot lead confirmé** : l'engine NE calcule JAMAIS `person.score` et NE
PATCH JAMAIS `person.score`. Le **bridge tunnel reste l'autorité unique du
score** (il fusionne Notifuse + analytics via `computeTunnelScore`, et a le
compare-and-set anti lost-update). L'engine expose seulement un endpoint
agrégat que le bridge consomme.

- Endpoint : `GET /api/tunnel.aggregate` (nom point-séparé, Bearer workspace,
  curseur incrémental, multi-tenant).
- **Shape de sortie = interface `AnalyticsAggregate` EXACTE** de
  `bridge/src/score-tunnel.ts` (le bridge la consomme telle quelle) :
  ```
  { userId, auditViews, auditScrollMax (0-100), hotPages (uniques),
    otherPages (uniques), consented, ctaClicks, rdvBooked,
    identifiedByEmail, appStarted, sessions, lastSeen }
  ```
- Sémantique d'agrégation = `bridge/src/analytics-pull.ts:aggregateEvents` :
  - HOT_PATHS = `/tarifs`, `/contact`, `/roi` (uniques) ;
  - CTA_GOALS = `audit_cta_rdv|appointment_click|roi_lead_click|cta_click` ;
  - RDV_GOALS = `rdv_booked` ; AUDIT_VIEW = `audit_view|audit_page_view` +
    `screen_view /audit/*` ; scroll ≥ 75 ;
  - `identifiedByEmail = userId.includes('@')` OU goal `signup` ;
  - `appStarted` = goal `app_started` AVEC `properties.app ∈
    {notifuse, prospection}` (roi-calculator EXCLU) ;
  - `consented` tracké mais ne score jamais.
- **Vert si** : l'endpoint retourne pour `acme-test-7h3k9x2p` (slug) :
  `auditViews≥1, auditScrollMax≥75, hotPages=1 (/tarifs), ctaClicks=1` ; et
  pour `bob.test@example.com` (email) : `rdvBooked=1, identifiedByEmail=true`.
  Union des 2 clés cohérente avec `mergeAggregates`.
- **Rouge si** : shape divergent de `AnalyticsAggregate` (un champ manquant
  casse le bridge), mauvais comptage hot/other pages, mauvais mapping CTA.

> ⚠️ **Désalignement de contrat à signaler** : la description de Task #5 liste
> les champs SANS `appStarted` ni `sessions`, alors que l'interface réelle
> `AnalyticsAggregate` les contient ET le scoring les utilise (`app_started`
> +40, `return_visit` +15 si sessions≥2). L'endpoint DOIT retourner
> l'interface complète. → remonté à twenty-connector + lead.

### SPEC-4 — Table webhook_deliveries (traçabilité + redaction)
- **4a Status** : les deliveries du parcours sont `status=success`,
  `http_status` ∈ {200,201}, `latency_ms` > 0 et raisonnable (< 10s).
- **4b Redaction** : AUCUN secret Bearer REPLAY en clair nulle part —
  `request_body`, `response_body`, `error_message` de `webhook_deliveries`, ET
  les logs du container engine (`docker logs`). Le Bearer ne vit que dans le
  header `authorization`, jamais persisté/loggué. Grep des logs sur un fragment
  du JWT REPLAY = 0 hit.
- **4c event_id** : chaque delivery porte le `dedup_token` comme `event_id`
  (idempotence vérifiable à l'œil).

### SPEC-5 — Multi-tenant strict
- Configurer un webhook sur le **tenant B** (`vrd_e2etestb_staging` → Lab).
- Émettre un event sur le **tenant A** (`vrd_veridian_site_staging`).
- **Vert si** : AUCUNE delivery créée pour le webhook de B ; le Lab ne reçoit
  RIEN. Réciproque testée.
- **Rouge si** : fuite cross-tenant (delivery de B déclenchée par event de A).

### SPEC-6 — Qualité data (BLOQUANT, clé Robert)
- **6a Email normalisé** : un identify avec `  Bob@EXAMPLE.COM ` doit résoudre/
  écrire l'email **lowercase + trim** (`bob@example.com`). Aucun mismatch de
  casse/espace.
- **6b Pas de null/champ vide parasite** : la timelineActivity n'a pas de
  `properties` avec des clés à `null`/`""` non significatives ; le PATCH score
  n'écrase pas des fields non concernés.
- **6c Pas de double-écriture** :
  - **Timeline** : un seul writer = le connecteur engine (#2). Aucune autre voie
    (bridge design A) ne doit écrire des timelineActivities en parallèle dans
    REPLAY pendant le test (sinon doublons) → bridge en DRY_RUN / débranché
    pour le test (lié Task #4).
  - **Score** : l'engine NE DOIT JAMAIS PATCHer `person.score` (autorité unique
    = bridge, SPEC-3bis/3c). Double writer score = lost-update garanti. Assertion
    négative : `person.score` n'est jamais modifié par une requête venant de
    l'engine.
- **6d Formats** : `score` est un NUMBER entier ; `providerClass` (si écrit) est
  une value UPPER_SNAKE_CASE valide ; `happensAt` ISO UTC valide.
- **Tout écart 6a-6d = BLOQUANT** (rapport rouge, ticket + SendMessage
  `twenty-connector`, NE PAS marquer #3 completed).

---

## 5. Méthode de vérification (outils)

- **Ingestion** : `POST /api/track` (curl/script) + `GET /api/export.userEvents`
  (Bearer admin engine) pour confirmer l'arrivée ClickHouse.
- **Twenty REPLAY** : `GET /rest/people?filter=auditSlug[eq]:...` +
  `GET /rest/timelineActivities?filter=...` + `GET /rest/people/{id}` (score).
  Comptage timeline avant/après pour l'idempotence.
- **Deliveries** : `webhooks.deliveries.list` (si API key dispo) OU requête
  ClickHouse directe `staminads_system.webhook_deliveries` via
  `ssh dev-pub docker exec ... clickhouse-client`.
- **Redaction logs** : `ssh dev-pub 'docker logs <engine-staging> --tail 500'`
  → grep fragment JWT REPLAY = 0 hit attendu.

## 6. Règle d'arrêt — quand #3 passe vert

TOUTES les specs 1→6 vertes, idempotence prouvée (replay = 0 doublon),
qualité data 6a-6d sans écart, redaction confirmée (0 secret en clair),
multi-tenant étanche. Alors et seulement alors : rapport vert au team-lead +
autorisation du lot decommission (Task #4).

Tout écart → rapport rouge spec par spec + ticket + SendMessage à
`twenty-connector` (je teste, je ne corrige PAS son code).
