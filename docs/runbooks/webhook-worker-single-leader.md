# Runbook — Webhook delivery worker is single-leader

> **TL;DR** : le worker qui livre les webhooks (`WebhookDeliveryWorker`) DOIT
> tourner sur **une seule instance active à la fois**. Le défaut (`WEBHOOK_WORKER_LEADER`
> non posé ⇒ `true`) est sûr en mono-instance. **Avant de scaler l'API engine à
> N réplicas, poser `WEBHOOK_WORKER_LEADER=false` sur tous les réplicas SAUF un.**

## Pourquoi (le vrai problème, sans enrobage)

`WebhooksService.findReadyDeliveries` lit les deliveries `pending`/`retrying` avec
un simple `SELECT … WHERE status IN ('pending','retrying')`. **Ce n'est PAS un
claim atomique.** ClickHouse n'a :

- ni `SELECT … FOR UPDATE`,
- ni transaction,
- ni `UPDATE … RETURNING` atomique fiable (les tables sont des `ReplacingMergeTree`,
  la déduplication est asynchrone au merge).

Et l'engine n'a **aucun backend de verrou** : c'est du ClickHouse pur, pas de
Postgres, pas de Redis (`api/package.json` ⇒ `@clickhouse/client` et c'est tout).
Un « claim » via une colonne `worker_id` + `lease_until` sur ClickHouse donnerait
une **illusion** d'atomicité : deux workers peuvent écrire leur claim sur la même
ligne et tous deux la traiter avant que le merge ne tranche un gagnant. Donc on ne
le fait pas.

**Conséquence :** si deux workers actifs pollent la même file en parallèle (≥2
réplicas, ou chevauchement de rolling-deploy où l'ancien et le nouveau container
pollent en même temps), ils lisent la **même** ligne `pending` et **POSTent deux
fois** la même delivery.

- Pour les destinations **Twenty**, l'idempotence UUIDv5 du connecteur absorbe le
  doublon (pas d'impact).
- Pour un webhook **générique** (Slack, n8n, endpoint client), le double POST
  **n'est PAS idempotent** ⇒ action déclenchée 2× chez le client. C'est un vrai bug
  visible.

## La garantie qu'on choisit (honnête, pas illusoire)

**Exactement un process draine la file.** Un seul lecteur ⇒ zéro concurrence ⇒
zéro double POST, vraiment (pas « probablement »). C'est garanti par un flag
applicatif :

| `WEBHOOK_WORKER_LEADER` | Comportement du worker sur cette instance |
|---|---|
| non posé / vide        | **leader** — draine la file (défaut fail-safe) |
| `true` (toute casse)   | **leader** — draine la file |
| n'importe quoi d'autre (`no`, `0`, `off`, typo…) | **leader** — draine la file *(seul `false` exact démote, pour ne jamais couper la livraison par erreur de frappe)* |
| `false` (toute casse, espaces tolérés) | **non-leader** — ne polle JAMAIS la file |

Au boot, le worker **log bruyamment** son état (`leader=true` ⇒ avertissement
single-instance ; `leader=false` ⇒ polling désactivé). Impossible de rater le
signal le jour du scale.

## Procédure : scaler l'API à N réplicas

1. Choisir UNE instance comme leader (laisser `WEBHOOK_WORKER_LEADER` non posé ou
   `true`).
2. Sur **tous les autres réplicas**, poser `WEBHOOK_WORKER_LEADER=false`
   (env Dokploy / compose override).
3. Vérifier dans les logs de chaque container :
   - leader : `[webhook-worker] leader=true — SINGLE-INSTANCE assumed…`
   - non-leader : `[webhook-worker] leader=false — delivery polling DISABLED…`
4. Si tous les containers logguent `leader=true` ⇒ **STOP**, tu vas double-POSTer.
   Corrige la config avant de continuer.

> Note rolling-deploy : pendant le bascule, l'ancien et le nouveau container du
> leader se chevauchent quelques secondes. En mono-instance c'est négligeable
> (fenêtre courte, file petite). Si tu veux fermer même cette fenêtre, déploie le
> leader en `recreate` (stop puis start) plutôt qu'en rolling, ou bascule
> temporairement le leader sur un autre réplica déjà à jour.

## Le jour où on a vraiment besoin de N workers actifs concurrents

Quand le volume de deliveries dépassera ce qu'un seul worker draine en 10s, il
faudra un **vrai claim distribué** — et donc un backend transactionnel. On
introduira à ce moment-là soit un Postgres (advisory lock `pg_try_advisory_lock`
par `delivery_id`, vraiment atomique), soit Redis/un broker. **On ne paie pas
cette infra tant que c'est dormant.** Ce runbook documente la décision (cf
`todo/done/2026-06-23-webhooks-claim-delivery-non-atomique-multi-instance.md`).

## Code de référence

- Gate : `api/src/webhooks/webhook-delivery-worker.service.ts` (`onModuleInit` +
  garde `isLeader` dans `tick`)
- Lecture non-atomique (documentée) : `api/src/webhooks/webhooks.service.ts`
  (`findReadyDeliveries`)
- Preuve e2e ClickHouse réel : `api/test/webhook-leader-gate.e2e-spec.ts`
- Tests unitaires du flag : `api/src/webhooks/webhook-delivery-worker.service.spec.ts`
  (`describe('single-leader gate …')`)
