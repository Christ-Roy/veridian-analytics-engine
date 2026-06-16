# Port natif VoIP (Calls OVH/Telnyx) — décision A vs B avant decommission bridge

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-16
> **Auteur audit** : agent audit-gsc-voip (Lot C, sprint decommission)
> **Statut** : DÉCISION REQUISE (Robert tranche A vs B) — PAS d'exécution avant GO

---

## 1. État actuel (cartographie code)

VoIP est **dans le bridge Express** (`veridian-bridge/src/voip/`). 9 fichiers :

| Fichier | Rôle |
|---|---|
| `credentials.ts` | **Lecture seule** des creds VoIP. Déchiffre les `TenantCredential` (kind `voip_ovh`/`voip_telnyx`) saisis par le tenant via Settings (U8). Ne duplique PAS le CRUD/chiffrement (c'est `src/credentials/`). |
| `providers/ovh.ts` | Client API OVH Telephony : auth signée SHA1, découvre billingAccounts→lignes→voiceConsumption, normalise en `NormalizedCall`. |
| `providers/telnyx.ts` | Client API Telnyx Detail Records (CDR), pagination + backoff, normalise en `NormalizedCall`. |
| `match.ts` | **NO-OP** depuis 2026-05-23 (tables Lead/LeadSession supprimées). Retourne toujours une map vide. Code mort fonctionnel. |
| `phone-numbers.ts` | `TenantPhoneNumber` : normalisation E.164 + lookup `(tenantId, toNumber)→source` (vision 2026-05-25 : 1 numéro = 1 source). |
| `phone-numbers.routes.ts` | CRUD admin `TenantPhoneNumber` (4 endpoints). |
| `sync.ts` | **Cœur** : pull CDR → upsert `SipCall` (Postgres-bridge) → **push chaque appel comme event `phone_call` vers `POST {staminads}/api/track`** (natif). |
| `query.ts` | Lecture `SipCall` pour l'onglet Settings VoIP (stats, daily, liste appels). |
| `routes.ts` | 3 endpoints admin : `sync`, `sync-all` (cron), `GET /tenant/:wsId/calls`. |

**Découverte clé — le push est DÉJÀ natif.** `sync.ts:pushStaminadsEvents` (lignes 168-244) pousse chaque appel comme event staminads via `POST /api/track` avec `type:'goal'`, `name:'phone_call'`, properties (direction, duration, status, from/to_number, **source**, provider, external_id). L'engine a bien `POST /api/track` natif (`api/src/events/events.controller.ts`) et la **démo prouve l'ingestion native** (`api/src/demo/fixtures/voip-calls.ts` insère exactement ce contrat dans ClickHouse → reconnu par Live/Explore/Goals). **Donc les appels apparaissent DÉJÀ nativement dans l'engine.** Conforme vision Robert 2026-05-23 (pas de page Calls custom).

**Ce qui reste dans le bridge = l'ORCHESTRATION uniquement** :
1. pull CDR providers (OVH signé / Telnyx Bearer),
2. déchiffrer les creds,
3. lookup source (`TenantPhoneNumber`),
4. push vers `/api/track`,
5. (résidu) upsert `SipCall` + tab Calls.

**Ce que la console consomme** : `console/src/veridian/settings-panels/voip-panel.tsx` (onglet Settings `voip`, conforme vision) fetch `fetchCalls` + `fetchPhoneNumbers` + `fetchTenantSettings` → **bridge** (`/api/admin/tenant/:ws/calls` lit `SipCall`, + CRUD phone-numbers). **Dépendance bridge sur le panneau Settings VoIP.**

**Code mort confirmé** (résidu scope tué, NE PAS porter) :
- `console/.../dashboard-tabs/calls-tab.tsx` (+ calls-hooks, calls-tab-views) : page Calls custom, référencée UNIQUEMENT par `_optional-features/dashboard.tsx` (= débranché). Robert a banni la page Calls. → à supprimer, pas à porter.
- `voip/match.ts` : no-op.
- table `SipCall` : double-stockage des appels (déjà dans ClickHouse via /api/track). Utile seulement pour le tab Calls Settings actuel.

**Déclenchement sync** : GitHub Action `voip-sync-cron.yml` → `/api/admin/voip/sync-all`. **Cron DÉSACTIVÉ** (`if: vars.VOIP_SYNC_ENABLED == 'true'`, schedule commenté). En prod, **les appels ne sont donc PAS pull automatiquement aujourd'hui.**

## 2. La question : VoIP rentre-t-il dans le modèle event staminads natif ?

**OUI pour le résultat (event `phone_call`), partiellement pour l'orchestration.**

- Le **résultat** (un appel = un event `phone_call`) est DÉJÀ 100 % natif : `/api/track` → ClickHouse → Live/Explore/Goals. Rien à porter côté ingestion.
- L'**orchestration** (pull CDR pull-based + creds chiffrés + cron) n'est PAS un event : c'est une couche d'intégration externe, comme GSC. MAIS plus légère que GSC (pas de query analytique relationnelle — la donnée finit dans ClickHouse, lue nativement).

C'est exactement le pattern du **connecteur Twenty natif** (`api/src/webhooks/connectors/twenty-*`) : un connecteur qui prend des events et les pousse vers un système externe. Ici c'est l'inverse (pull externe → events natifs), mais la place architecturale est la même : un **module connecteur dans l'engine**.

## 3. Options

### Option A — Module connecteur VoIP natif dans l'engine (RECO)

Porter l'orchestration dans un module NestJS `api/src/voip/` (ou `webhooks/connectors/voip/` par cohérence avec Twenty) :
- **Creds** : `common/crypto.ts` natif (AES-256-GCM clé-par-workspace). Table engine pour les creds VoIP + `TenantPhoneNumber`.
- **Pull** : porter `providers/ovh.ts` + `providers/telnyx.ts` tels quels (logique pure, zéro dépendance bridge — juste `fetch` + crypto SHA1).
- **Push** : l'event `phone_call` part déjà vers `/api/track` → en natif, c'est un appel **interne** au lieu d'un HTTP externe (l'engine s'auto-ingère). Encore plus propre.
- **Cron** : `@Cron()` natif (`ScheduleModule` déjà présent, cf `subscription-scheduler`). Plus de GH Action.
- **Settings VoIP** : repointer `voip-panel.tsx` vers l'engine. Si on **abandonne le tab "liste d'appels"** (Robert a banni la page Calls — les appels sont déjà dans Live/Explore natifs), on n'a même plus besoin de la table `SipCall` ni de `query.ts`/`listCalls` : le panel Settings VoIP devient juste "connecter OVH/Telnyx + mapper numéros→sources + statut sync". **Reco : supprimer `SipCall` + tab Calls, garder uniquement config + statut.**

**Avantages** :
- Le push est déjà natif → la moitié du travail est faite.
- Élimine le bridge pour VoIP → débloque Lot E.
- Supprime le double-stockage (`SipCall` redondant avec ClickHouse).
- Cron + crypto natifs gratuits.
- Cohérent avec le connecteur Twenty (pattern établi).

**Inconvénients** :
- Module métier dans le fork AGPL (déjà accepté, cf Twenty/demo).
- Migration creds (`TenantCredential` + `TenantPhoneNumber`) bridge → engine. Volume faible (5 clients, 1-2 providers chacun).
- Décision UX : supprimer le tab liste-appels Settings (recommandé mais à confirmer Robert — voir §5).

### Option B — Couche d'intégration VoIP séparée (micro-service)

Extraire `voip/` du bridge vers un micro-service VoIP autonome qui pull et push vers `/api/track`.

**Avantages** : isole le métier hors du fork AGPL.

**Inconvénients** : **recrée le bridge** (Express + Postgres + cron + Bearer admin). Contraire à la règle d'or "propre first, zéro contournement". 2 backends au lieu d'1. Auth Bearer admin global (anti-pattern Lot B). Et c'est encore plus injustifié que pour GSC, car le push est déjà natif — un micro-service juste pour faire 4 appels HTTP de pull = surdimensionné.

## 4. Recommandation chiffrée

**Option A — module connecteur VoIP natif — à ~85 %.**

Raison business : VoIP (Calls) est la **2e feature commercialisable** (après visiteurs uniques), différenciante (téléphonie OVH = argument de vente). Le push étant déjà natif, le port natif de l'orchestration est le chemin le plus court ET le plus propre. B (micro-service) recrée exactement le bridge qu'on tue — non.

Confiance plus haute que GSC (85 vs 80) car : (1) le push natif réduit le risque, (2) les providers sont de la logique pure portable sans friction, (3) on peut au passage supprimer le double-stockage `SipCall` (simplification nette).

**Effort estimé Option A** : ~2 jours dev (1 agent Opus) :
- Module `voip/` engine (creds service + providers portés + sync cron + push interne) : ~1j
- Migration schéma engine (creds VoIP + `TenantPhoneNumber`) + migration data (5 clients) : ~0,5j
- Repointage `voip-panel.tsx` + suppression code mort (calls-tab, SipCall, query.ts si tab liste abandonné) + tests E2E : ~0,5j

## 5. Risques

- **Décision UX tab Calls** : le `voip-panel.tsx` actuel affiche une liste d'appels (via `SipCall`). La vision dit "appels dans Live/Explore natifs, pas de page custom". **Question Robert** : garde-t-on une liste d'appels brute dans le panneau Settings VoIP (confort opérateur), ou on se repose 100 % sur Live/Explore natifs ? Reco : 100 % natif (supprimer `SipCall`), mais c'est un arbitrage produit, pas technique.
- **Creds OVH/Telnyx en clair pendant migration** : déchiffrer bridge → re-chiffrer engine. Faire en mémoire, jamais de dump clair. Ou re-saisie (5 clients).
- **Push interne vs HTTP** : aujourd'hui le bridge POST en HTTP vers `/api/track`. En natif, préférer un appel interne au service events (évite un aller-retour HTTP + auth). À cadrer dans l'impl.
- **OVH `voiceConsumption` sans filtre date** : le client OVH pull TOUTES les consos puis filtre client-side (cap 2000/ligne). Pour 5 clients FR c'est OK, mais à surveiller si volume monte.

## 6. DoD (Option A)

- [ ] Module `api/src/voip/` (ou `webhooks/connectors/voip/`) : creds service (crypto clé-workspace) + providers OVH/Telnyx portés + sync `@Cron` + push interne event `phone_call`.
- [ ] Migration schéma engine : creds VoIP + `TenantPhoneNumber` (enum source). Data 5 clients migrée OU re-saisie.
- [ ] Cron natif `@Cron` enregistré + observable. GH Action `voip-sync-cron.yml` supprimée.
- [ ] `voip-panel.tsx` repointé engine (config + mapping numéros→sources + statut sync).
- [ ] Décision Robert tranchée sur tab liste-appels (cf §5). Si "100 % natif" : `SipCall` + `query.ts` + calls-tab supprimés.
- [ ] Code mort supprimé : `calls-tab.tsx`/`calls-hooks`/`calls-tab-views`, `voip/match.ts`.
- [ ] E2E staging : connecter un provider test → sync → event `phone_call` visible dans Live/Explore/Goals natifs + filtrable par `source`.
- [ ] Code VoIP supprimé du bridge (`veridian-bridge/src/voip/`) — débloque Lot E.

## 7. Dépendance decommission (Lot E)

🔴 **VoIP natif (A) ou couche propre (B) DOIT être livré et la console repointée AVANT de couper le bridge.** Tant que `voip-panel.tsx` fetch le bridge (`/calls`, `/phone-numbers`), couper le bridge casse l'onglet VoIP. Ordre :
1. Port VoIP (A) livré + testé staging (sync + event natif + panel Settings)
2. Console repointée engine + E2E vert
3. Bridge VoIP routes mortes
4. → Lot E peut couper le bridge

⚠️ **Note transverse** : GSC ([[2026-06-16-port-natif-gsc]]) et VoIP partagent le bridge. Le bridge ne peut être coupé (Lot E) que quand **LES DEUX** sont portés/repointés. Les deux ports peuvent se faire en parallèle (modules indépendants), mais Lot E attend le dernier des deux.
