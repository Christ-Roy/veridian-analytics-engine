# 🔴 P0 — Le kill-switch `status!='active'` droppe 100% de l'ingestion des workspaces restés `initializing`, et `tracking.verify` est AVEUGLE à ce drop

> **Sévérité** : 🔴 **P0 BLOQUANT PROD** — perte silencieuse de TOUTE l'ingestion navigateur de tout workspace provisionné normalement. Aucune conversion mesurée (login, onboarding, achat, réservation) sur AUCUN client.
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Demandé par** : lead Veridian (diagnostic Yoga Sculpt — un inscrit payant Google Ads invisible dans l'engine)

---

## TL;DR

1. Un workspace est créé en `status: 'initializing'` (`workspaces.service.ts:181`).
2. **AUCUN code, nulle part, ne le fait jamais passer à `'active'`.** Le commentaire `workspaces.service.ts:236` (*« Status remains 'initializing' until first event is received »*) décrit un mécanisme **jamais implémenté**.
3. Le 2026-06-23, commit `299f5d8` (*fix(security): harden public /api/track ingestion endpoint*) ajoute un kill-switch `session-payload.handler.ts:63` : `if (workspace.status !== 'active') return { success: true }` → **droppe tout, réponse 200 muette**.
4. Conséquence : tout workspace provisionné via le flux standard **droppe 100% de son trafic navigateur** (`/api/track`), en silence, indéfiniment.
5. **Pourquoi on ne l'a pas vu à la config** : `tracking.verify` (la commande censée prouver le round-trip) **court-circuite le handler `/api/track`** et insère en base direct (`admin-platform.service.ts:1263` `insertWorkspace(...'events'...)`) → il ne traverse JAMAIS le kill-switch ni le check domaine. Il renvoie `verdict: ok` pendant que l'ingestion réelle est morte. **Faux positif structurel.**

---

## Preuve reproductible (CLI + curl)

```bash
# 1. Le workspace est bloqué en initializing
analytics status yoga_sculpt | jq .status          # → "initializing"

# 2. verify ment : il dit OK
analytics verify yoga_sculpt                         # → verdict "ok", round-trip OK

# 3. Mais l'ingestion RÉELLE (le vrai flux navigateur) droppe tout :
NOW=$(date +%s%3N)
curl -s -X POST https://analytics-engine.app.veridian.site/api/track \
  -H 'Content-Type: application/json' -H 'Origin: https://app.yoga-sculpt.fr' \
  -d "{\"workspace_id\":\"yoga_sculpt\",\"session_id\":\"diag_$NOW\",\"user_id\":\"diag@test\",
       \"created_at\":$NOW,\"updated_at\":$NOW,
       \"attributes\":{\"landing_page\":\"https://app.yoga-sculpt.fr/espace\"},
       \"actions\":[{\"type\":\"goal\",\"name\":\"diag_login\",\"path\":\"/espace\",\"page_number\":1,\"timestamp\":$NOW}]}"
# → {"success":true}   (MENSONGE : 200 muet du kill-switch)

# 4. L'event n'est jamais stocké :
#    table goals (today) = 0 row, table sessions user_id (today) = 0 row. Vérifié.
```

Résultat réel constaté sur `yoga_sculpt` (prod) : 10 sessions ingérées AVANT le 2026-06-23 (anonymes, `user_id=null`), **zéro goal métier de l'app**, et un inscrit payant Google Ads (Michele Fardele, 2026-06-24) **totalement invisible** dans l'engine. La provenance n'a pu être retrouvée que via Supabase (champ `gclid` capté à l'inscription) — l'engine, lui, n'avait rien.

---

## Ce qui n'est PAS en cause (déjà vérifié)

- **Code app** (`yoga-sculpt-app`) : correct. Init inconditionnelle, `identify(user.email||user.id)`, `trackFunnel`/FUNNEL câblés (onboarding/checkout/purchase/réservation). RAS.
- **Bundle SDK** `/sdk/v1/tracker.js` : sain (200, expose `Staminads.init/setUserId/trackGoal`, POST vers `/api/track`).
- **Config workspace** (snippet, workspace_id, endpoint, clé) : RAS.

Le défaut est **100% côté engine** : un état `initializing` sans transition de sortie, sur lequel on a branché un kill-switch, plus un `verify` qui ne teste pas la vraie porte d'entrée.

---

## Correctifs demandés

### A — Déblocage immédiat (prod) — testable CLI
Repasser les workspaces coincés en `active`. **Doit être faisable et vérifiable au CLI** :
```bash
analytics workspace:activate yoga_sculpt        # nouvelle sous-commande à créer (cf C)
# OU, si update générique : analytics raw POST /api/admin/platform/workspaces.update '{"id":"yoga_sculpt","status":"active"}'
analytics status yoga_sculpt | jq .status        # → doit afficher "active"
```
Lister et activer TOUS les workspaces actuellement en `initializing` (pas que yoga_sculpt) — ils sont tous cassés.

### B — Fix de fond (le cœur du bug) — au choix, idéalement les deux
1. **Implémenter la transition manquante** : dans `session-payload.handler.ts`, dès qu'un payload valide est ingéré pour un workspace `initializing`, flipper `status → 'active'` (best-effort, async, ne bloque pas l'ingestion). C'est ce que le commentaire l.236 promet depuis toujours. **Et accepter `initializing` dans le kill-switch** (ne bloquer QUE `inactive`/`error`/suspendu), sinon le tout premier event est lui-même droppé → blocage éternel (cercle vicieux : il faut un event pour devenir active, mais le kill-switch jette les events tant qu'on n'est pas active).
2. **OU** provisionner directement en `active` (`workspaces.service.ts:181`) si l'`initializing` n'a pas d'autre rôle fonctionnel — à arbitrer selon ce que `initializing` est censé garantir (rien aujourd'hui, vu qu'aucune transition n'existe).

> Décider explicitement le rôle de `initializing` : soit il a une sémantique (et alors une transition + un test), soit il dégage. Un état sans sortie branché à un kill-switch = piège à retardement.

### C — Fermer le trou de détection (pour que ÇA NE SE REPRODUISE JAMAIS) — priorité lead
**C'est LE vrai problème** : on a "configuré" un client sans jamais tester le flux réel. À corriger structurellement :

1. **`tracking.verify` doit tester la VRAIE porte d'entrée `/api/track`**, pas un insert base direct. Soit en plus du round-trip bas niveau (garder le check table+MV), ajouter un **probe HTTP réel** qui POST sur `/api/track` avec un event sentinelle (timestamp far-past + purge, même garantie zéro-pollution qu'aujourd'hui) et vérifie qu'il **ressort** côté requête. Si le kill-switch / le domain-check / la validation DTO droppe, `verify` DOIT le voir et renvoyer un verdict d'échec explicite (`verdict: "ingestion_dropped_workspace_inactive"`, etc.). Aujourd'hui `verify` est un faux ami : il valide une moitié de chaîne qui ne correspond pas au trafic réel.
2. **Étendre le `verdict`** de `tracking.verify` pour distinguer : `ok` / `ingestion_failed` / `dropped_workspace_inactive` / `dropped_domain_not_allowed` / `snippet_*`. L'IA qui provisionne doit recevoir une réponse actionnable, pas un OK trompeur.
3. **`analytics provision` doit finir par un `verify` HTTP réel** (post-provision self-test) et **refuser de rendre la main en "OK"** si le flux `/api/track` ne ressort pas. Provisionner = livrer un workspace qui ingère *vraiment*, prouvé bout-en-bout.
4. **Sous-commandes CLI manquantes** (tout doit être pilotable/inspectable CLI) :
   - `analytics workspace:activate <ws>` / `workspace:status <ws>` (lire/écrire le `WorkspaceStatus`).
   - `analytics workspace:list [--status initializing]` pour repérer les workspaces cassés.
   - `analytics verify <ws> --real` (probe HTTP `/api/track` end-to-end, en plus du dry-run base).

### D — Test de non-régression
Test e2e : provisionner un workspace neuf → POST `/api/track` → l'event DOIT ressortir en query. Aujourd'hui ce test n'existe pas (sinon le kill-switch de `299f5d8` aurait cassé la CI). C'est l'absence de ce test qui a laissé passer le bug.

---

## Definition of Done
- [ ] `yoga_sculpt` (+ tous les `initializing`) repassés `active`, vérifié `analytics status` = active.
- [ ] Un POST `/api/track` réel sur un workspace fraîchement provisionné ressort en query (prouvé CLI).
- [ ] `tracking.verify` teste `/api/track` réel et renvoie un verdict d'échec si l'ingestion droppe.
- [ ] `analytics provision` échoue bruyamment si le self-test HTTP post-provision ne passe pas.
- [ ] Sous-commandes `workspace:activate/status/list` dispo au CLI.
- [ ] Test e2e provision→track→query en CI (rouge si on recasse l'ingestion).
