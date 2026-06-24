# Claim de delivery webhook non atomique → double envoi si ≥2 instances

> **Sévérité** : 🟢 P2 (latent — dormant en mono-instance, bloquant au scale)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23
> **RÉSOLU** : 2026-06-25 — voie C-leader (single-leader gate fail-safe)

## ✅ Résolution (2026-06-25)

Décision tranchée après analyse des 3 voies du ticket :

- **B (advisory lock Postgres)** écartée : l'engine n'a AUCUN Postgres
  (`api/package.json` ⇒ `@clickhouse/client` uniquement, pas de pg/redis). La
  proposer = ajouter une dépendance + provisionner une instance PG pour un P2
  dormant. Disproportionné. (Le ticket supposait « l'engine a un Postgres » —
  faux pour ce repo, confusion avec le Hub.)
- **A (claim worker_id + lease_until sur ClickHouse)** écartée : fausse
  atomicité. ReplacingMergeTree déduplique au merge (async) — deux workers
  peuvent écrire leur claim et tous deux POSTer avant que le merge ne tranche.
  Illusion d'unicité, pas une garantie.
- **C (single-leader)** retenue, durcie fail-safe : un flag
  `WEBHOOK_WORKER_LEADER` (défaut `true`) garde le polling. Exactement UN
  process draine la file ⇒ un seul lecteur ⇒ zéro race, vraiment. Défaut sûr en
  mono-instance ; pour scaler, poser `false` sur tous les réplicas sauf un. Log
  bruyant au boot pour rendre l'hypothèse single-instance impossible à rater.

Implémentation (un seul commit, branche `staging`) :
- Gate `onModuleInit` + garde `isLeader` dans `tick`
  (`api/src/webhooks/webhook-delivery-worker.service.ts`)
- Docstring `findReadyDeliveries` mise à jour (non-atomique = assumé)
- ENV câblé : `compose.yaml`, `compose-demo.yaml` (`${WEBHOOK_WORKER_LEADER:-true}`)
  + `api/.env.example`
- Tests unitaires du flag (`webhook-delivery-worker.service.spec.ts`)
- Preuve e2e ClickHouse réel + sabotage 2-workers
  (`api/test/webhook-leader-gate.e2e-spec.ts`)
- Runbook `docs/runbooks/webhook-worker-single-leader.md`

Le jour où N workers actifs concurrents deviennent un vrai besoin (volume), on
introduira un backend de lock (PG advisory lock / Redis). Pas avant — c'est
dormant.

## Contexte / Symptôme

`findReadyDeliveries` fait un simple `SELECT ... WHERE status IN ('pending','retrying')`
sans marquer les lignes "in-flight" de façon atomique
(`webhooks.service.ts:338-348`). Le seul garde-fou est le booléen `this.running`
qui protège **un seul process** (`webhook-delivery-worker.service.ts:59-70`).
ClickHouse n'a ni `SELECT ... FOR UPDATE` ni transaction → aucun verrou.

Si l'app tourne en 2+ réplicas (ou pendant un rolling-deploy où ancien et nouveau
container se chevauchent), les deux workers lisent la même ligne `pending` et
POSTent **deux fois** la même delivery dans la fenêtre de 10s.

État actuel : aucun réplica configuré dans les composes (`grep replicas` = vide)
→ mono-instance en prod, donc **non exploité aujourd'hui**. Mais latent : tout
passage à 2 réplicas (ou overlap de deploy) casse la garantie. Pour Twenty,
l'idempotence UUIDv5 absorbe le doublon ; pour un webhook **générique**
(Slack, n8n, endpoint client), le double POST n'est PAS idempotent → action
déclenchée 2×.

## Localisation (fichiers + lignes)

- `api/src/webhooks/webhooks.service.ts:338-348` — `findReadyDeliveries` (pas de claim atomique)
- `api/src/webhooks/webhook-delivery-worker.service.ts:59-70` — guard `this.running` intra-process

## Correctif proposé

Claim atomique : transition d'état `pending → sending` avec `worker_id` +
`lease_until`, puis ne traiter que les lignes dont on est l'auteur du claim
(relire en `FINAL`, vérifier le `worker_id`). À défaut de fixer maintenant :
documenter explicitement "single-instance only" + garde au boot qui refuse de
scaler (et l'inscrire dans le runbook de deploy pour éviter un overlap qui
double-déclenche).

## Impact si non corrigé

Double déclenchement d'actions chez le client sur webhooks génériques au
scale-out ou pendant un overlap de déploiement. Dormant en mono-instance, mais
piège silencieux dès qu'on scale.
