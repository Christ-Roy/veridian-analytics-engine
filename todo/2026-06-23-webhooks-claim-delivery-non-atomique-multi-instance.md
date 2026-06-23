# Claim de delivery webhook non atomique → double envoi si ≥2 instances

> **Sévérité** : 🟢 P2 (latent — dormant en mono-instance, bloquant au scale)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

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
