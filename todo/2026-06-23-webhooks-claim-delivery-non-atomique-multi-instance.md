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

## Réponse agent — 2026-06-23 (laissé en ticket, justifié)

**Décision : NON fixé dans cette passe sécu, laissé en ticket avec garde-fou.**

Vérifié : `grep -rn replicas` sur tous les composes (`compose.yaml`,
`compose/{base,prod,staging,demo,dev,test}.yml`) = **vide**. Prod = mono-instance
confirmé → le bug est purement **latent**, non exploité aujourd'hui.

Pourquoi je ne le fixe pas maintenant (et c'est le bon arbitrage) :
- Un claim atomique correct sur ClickHouse n'existe pas nativement (pas de
  `SELECT…FOR UPDATE`, pas de transaction). La voie propre = **migration de
  schéma** (colonnes `worker_id` + `lease_until` sur `webhook_deliveries`) +
  transition `pending → sending` claimée + relecture `FINAL` avec vérif
  `worker_id`. C'est du tier 🔴 (migration DB), bien plus lourd/risqué que les
  3 fixes sécu de la même salve, et hors du focus "3 sécu".
- Le fixer à moitié (claim non transactionnel sur ClickHouse) donnerait une
  fausse sécurité sans réelle atomicité → pire que la garde documentée.

Garde-fou posé à la place (mitigation low-risk, zéro migration) :
- Commentaire explicite `⚠️ NOT an atomic claim` sur `findReadyDeliveries`
  (`webhooks.service.ts`) : interdiction de scaler à >1 réplica sans ce fix.
- À inscrire au runbook deploy : pas d'overlap ancien/nouveau container sur le
  worker (rolling-deploy OK tant que `replicas: 1`).

**À rouvrir/prioriser AVANT** tout passage à `replicas: 2+` ou tout déploiement
faisant tourner deux workers en parallèle.
