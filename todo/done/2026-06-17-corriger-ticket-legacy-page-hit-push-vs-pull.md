# [ANALYTICS-ENGINE] 🟢 P2 — Le ticket "émettre page.hit vers le Hub" est PÉRIMÉ : design basculé PUSH → PULL, rien à coder côté engine

> **Sévérité** : 🟢 P2 (pas un trou de code engine — un trou de DOCUMENTATION : un ticket décrit un travail qui n'a plus lieu d'être et qui ferait DOUBLE EMPLOI)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17 (audit cohérence identité/réconciliateur, agent audit-identite)

## TL;DR

Un ticket legacy
(`veridian-analytics/todo/2026-06-17-emettre-page-hit-vid-vers-hub-reconciliateur.md`,
rédigé par audit-crossapp) demande à l'engine d'**émettre (PUSH)** un event
`page.hit` v1.4 Bearer vers `POST hub.../api/webhooks/analytics`. **Ce travail
ne doit PAS être fait** : le design a basculé en **PULL** le 2026-06-17. C'est
le **Hub qui pull** l'engine (`export.userEvents`) et fabrique lui-même les
`page.hit`. Coder un émetteur PUSH côté engine créerait un DOUBLE flux (double
ingestion, double scoring). À fermer.

## Preuve (les deux bouts, code daté 2026-06-17)

### Le réconciliateur PULL existe et est câblé côté Hub
- `veridian-hub/lib/prospect/analytics-pull.ts` (daté 2026-06-17) : le Hub pull
  `export.userEvents` sur fenêtre fixe 48 h → agrège par identité → `page.hit` +
  jalons audit via `ingestProspectEvent` (idempotency_key DÉTERMINISTE :
  `analytics:<identity>:page.hit:<path>`).
- `veridian-hub/app/api/cron/pull-analytics/route.ts` + workflow
  `hub-pull-analytics-cron.yml` (`37 * * * *`, horaire, prod). Tests :
  `__tests__/api/cron/pull-analytics.test.ts`, `__tests__/lib/prospect/analytics-pull.test.ts`.
- En-tête de `analytics-pull.ts` : *"le Hub n'a pas de store parallèle — il
  ingère dans la VRAIE table `prospect_events`"* + *"UN passage = pull
  export.userEvents sur une FENÊTRE FIXE de 48 h"*. C'est un PULL assumé,
  doctrine "clean et smart" Robert 2026-06-17.

### Côté engine : RIEN à émettre — l'engine EXPOSE, il ne pousse pas
- L'identité voyage déjà nativement : SDK `setUserId(slug|email)` →
  `payload.user_id` → ClickHouse `events.user_id` → `GET /api/export.userEvents`
  (`api/src/export/export.service.ts`, filtre `user_id IS NOT NULL`). Chaîne
  validée E2E staging + prod (`docs/TUNNEL-IDENTITE.md`, spec
  `api/test/user-id-export.e2e-spec.ts`).
- L'engine expose AUSSI `GET /api/tunnel.aggregate` (`api/src/tunnel/`) — autre
  consommateur pull (le bridge historique). Aucun de ces deux chemins n'est un
  PUSH vers le Hub. Le doc README connectors le grave : *"The engine only
  EXPOSES analytics aggregates"*.
- Grep côté engine : aucun `HUB_WEBHOOK`, aucun `POST .../webhooks/analytics`,
  aucun émetteur sortant vers le Hub. Et il n'en faut pas.

## Pourquoi le ticket legacy se trompe
Il a été rédigé en auditant le **repo legacy Next.js** `veridian-analytics`
(condamné, cf `CLAUDE.md` VISION 2026-05-23), où effectivement rien n'émettait.
Mais la cible vivante est l'**engine**, et l'engine n'a jamais eu à émettre :
le Hub vient CHERCHER les events via l'export REST. Le ticket décrit un design
(PUSH webhook v1.4) qui a été **abandonné au profit du PULL** le même jour
(2026-06-17), probablement après que le ticket ait été écrit le matin.

## Demande précise (quoi faire)

1. **Fermer/annuler le ticket legacy**
   `veridian-analytics/todo/2026-06-17-emettre-page-hit-vid-vers-hub-reconciliateur.md`
   en y ajoutant une section `## Réponse — 2026-06-17 (audit-identite)` :
   "Design basculé PUSH → PULL. Le Hub pull `export.userEvents`
   (`lib/prospect/analytics-pull.ts`, cron horaire). L'engine n'a RIEN à
   émettre. Ticket annulé — voir le vrai bloquant : ENV `ENGINE_ADMIN_*`
   manquantes dans le compose Hub prod
   (`veridian-hub/todo/2026-06-17-cabler-env-engine-admin-pull-analytics-prod.md`)."
   Puis `mv` vers `done/`.
2. **Côté engine : 0 ligne de code à écrire.** La chaîne identité (setUserId →
   user_id → export) est déjà complète, testée, en prod. Ne PAS créer
   d'émetteur, ne PAS ajouter de `vid` capture côté SDK pour ce besoin (l'étage
   2 vid est un autre lot, cf ci-dessous).
3. **Signaler au lead** que le ticket miroir Hub
   `veridian-hub/todo/2026-06-17-creer-route-webhook-analytics-page-hit.md`
   (route réceptrice PUSH) est lui aussi à annuler — inutile en design PULL.
   (Action portée par le ticket Hub
   `2026-06-17-cabler-env-engine-admin-pull-analytics-prod.md`, section "DOC".)

## Étage 2 (vid) — distinct, non bloquant, à NE PAS confondre
Le `vid` déterministe partagé (Hub source → propagé par Notifuse dans les liens
`/r/` → capté par l'engine au hit pour jointure FORTE cold↔web) reste non câblé
(`CONTRAT-HUB.md §7.5.4`, `analytics-pull.ts` met `vid = slug` faute de mieux).
Au V1 la jointure web↔prospect se fait par `contact_email` (le visiteur doit
s'être identifié par email via `identify(email)` côté site). C'est un lot futur
réel, MAIS il ne change rien au fait que le transport reste un PULL. Si Robert
veut l'étage 2, ce sera : (a) Hub génère le vid, (b) Notifuse le pose dans les
liens, (c) le SITE appelle `identify(vid)` à l'arrivée → user_id = vid → remonté
nativement par l'export PULL existant. Toujours zéro émetteur PUSH côté engine.

## Impact business
Faible en soi (c'est de l'hygiène de backlog), mais IMPORTANT pour ne pas qu'un
futur agent code un émetteur PUSH redondant en lisant le ticket legacy → double
ingestion = double comptage des `page.hit` = score prospect faussé. Fermer le
ticket évite ce piège. Le vrai débloquage du tunnel cold↔web est côté Hub (ENV).
## Réponse — 2026-06-18 (team-lead)

Fait : ticket legacy `veridian-analytics/todo/2026-06-17-emettre-page-hit-vid-vers-hub-reconciliateur.md` annoté (design PULL, engine n'émet rien) + archivé dans le `done/` du legacy. Les tickets Hub (ENV ENGINE_ADMIN_* P0 + route webhook PUSH à annuler) restent à router à l'agent Hub.
