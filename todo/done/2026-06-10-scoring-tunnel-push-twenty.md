# Scoring comportemental tunnel V1 + push vers Twenty

> **Sévérité** : 🔴 P0 — sprint tunnel de vente outbound
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-10
> **Tâche team** : #14 (bloquée par #12 — levée, identité validée E2E)
> **Pré-requis contrat** : CONTRATS-TUNNEL §4 figé (events + identify(slug))
>   + champ score côté Twenty (TBD twenty-crm)

## Objectif

Trier les prospects outbound **tiède/chaud** à partir de leur comportement
sur les pages audit (et le reste du site), et pousser le résultat dans
Twenty pour que le commercial appelle les plus chauds d'abord. Pas de ML —
pondération fixe V1.

## Design V1 (à valider lead avant code)

### Source de données

`GET /api/export.userEvents` (workspace `vrd_veridian_site_prod`,
`user_id IS NOT NULL`, curseur incrémental). Identités = slug audit
(outbound) ∪ email normalisé (post-identify) — union via le mapping
slug↔email du batch (présent sur la Person Twenty).
⚠️ TTL 7 jours sur les events bruts → sync au moins quotidienne.

### Score V1 (pondération à affiner avec le lead)

| Signal | Points |
|---|---|
| arrivée page audit (`screen_view /audit/<slug>`) | 10 |
| scroll ≥ 75 sur la page audit | +10 |
| goal `consent_granted` | +5 |
| navigation au-delà de l'audit (par page clé : /tarifs, ROI) | +15 |
| goal `cta_click` | +20 |
| goal `rdv_booked` | +50 |
| bonus récence : events < 48h | ×1.5 |

Labels : 0 = froid (pas venu) · 1-29 = tiède · ≥30 = chaud.

### Transport (webhook + cron réconcile, §3.3 archi — OBLIGATOIRE les deux)

> ⚠️ MAJ 2026-06-10 (décision lead, tâche team #17 + CONTRATS-TUNNEL §7) :
> le consommateur est le **bridge réconciliateur unique sur dev-pub**
> (commun Notifuse + Analytics), spec en cours par l'architecte. C'est
> MOI (agent analytics) qui l'implémente — le scoring ci-dessous atterrit
> dedans, pas dans le veridian-bridge de l'engine.

1. **Temps réel** : webhook engine (module destinations multi-tenant,
   `event.tracked`, filtre workspace tunnel + HMAC) → réconciliateur
   dev-pub → re-score incrémental du `user_id` touché → push Twenty
   (timeline batchée 60/call, 100 req/min, dédup, cache email→Person).
2. **Cron réconciliation quotidien minimum** (dans le réconciliateur,
   contrainte TTL ClickHouse 7j) : full pass export par curseur →
   recompute tous les scores → compare avec Twenty → PATCH les écarts +
   timestamp de fraîcheur (observabilité §3.3).

### Push Twenty (champ cible TBD twenty-crm via CONTRATS-TUNNEL)

- Clé de réconciliation = **email normalisé** → Person.
- Score → field NUMBER (tri `orderBy=score[DescNullsLast]` dans la vue
  tunnel) + label/stage selon mapping stages (TBD twenty-crm).
- Events notables (rdv_booked, cta_click) → `POST /rest/timelineActivities`
  (batch 60/call, 100 req/min, pas d'upsert REST → GET-then-PATCH).
- État de sync côté bridge (Postgres) : curseur export + dernier score
  poussé par identité (idempotence + diff réconcile).

## Auth du réconciliateur vers export.userEvents (vérifié 2026-06-10)

- ❌ `POST /api/apiKeys.create` sur le workspace tunnel → 403 "Not a member
  of this workspace" même en super-admin (les workspaces platform-managed
  n'ont AUCUN membre, et le service exige une membership réelle).
- ✅ **JWT super-admin** (login `admin@veridian.site`) passe le
  `WorkspaceAuthGuard` de l'export → solution V1 : le réconciliateur fait
  un `auth.login` programmatique et rafraîchit son token (expiration 7j).
- Amélioration V2 (si besoin) : étendre `provision-workspace.js` pour
  créer une API key workspace au provisioning (évolution engine, ticket
  séparé si l'architecte la demande).

## Étapes

1. Valider design + pondération avec le lead (ce ticket).
2. Attendre champ score/stages figés par twenty-crm (CONTRATS §4).
3. Implémenter module bridge `tunnel/` (scoring pur + tests unitaires).
4. Câbler webhook destination engine → bridge (staging d'abord).
5. Cron réconcile + table d'état Postgres bridge.
6. E2E staging : events simulés → score dans Twenty sandbox.
7. Gate lead avant branchement prod (#11).
