# 🔴 INCIDENT prod : réseau Docker `engine-internal` au routage cassé → engine ne joint pas ClickHouse

> **Sévérité** : 🔴 P0 (prod down ~plusieurs heures 2026-06-19/20) — RUSTINE runtime en place, fix durable requis
> **Owner** : team-lead / infra veridian-analytics-engine
> **Créé** : 2026-06-20

## Résumé incident

Suite au redeploy de la vague UI (`b1638ae`, 2026-06-19), un deploy Dokploy s'est
**bloqué** (`running` ~1h sans finir), laissant le réseau Docker
`analytics-engine-prod-gkggyk_engine-internal` (bridge `br-61a0698a406a`, subnet
172.20.0.0/16) dans un état où **le routage inter-container ne passe plus** :
`engine→clickhouse:8123`, `engine→clickhouse:9000`, `engine→postgres-bridge:5432`
TOUS en `Operation timed out`. L'engine crashait en boucle au migrate-on-boot
(`[Migrations] timeout ClickHouse`), prod 404.

**La vague UI n'est PAS la cause** : `git diff 63850f5..b1638ae -- api/ Dockerfile
compose/` = VIDE (100% console/). N'importe quel redeploy aurait déclenché le bug.

## Ce qui N'A PAS marché (testé)

- `compose.deploy` Dokploy (×3) → error (engine unhealthy car CH injoignable)
- `docker restart` clickhouse + engine
- `network rm` + redeploy
- `docker compose down --remove-orphans` + `up`/redeploy (réseau recréé propre)
- `systemctl restart docker` (régénère iptables) → routage TOUJOURS cassé
- Ajout règle `iptables -I FORWARD -i br-X -o br-X -j ACCEPT` → timeout quand même

→ Donc PAS un simple souci iptables/UFW transitoire. Le bridge `engine-internal`
lui-même ne fait pas passer le trafic L2/L3 entre ses interfaces, de façon
reproductible et persistante aux recreates. Cause kernel/netfilter exacte non
élucidée (subnet 172.20.0.0/16 "poisoned" ? bridge nf_call corrompu ?).

## Ce qui A marché (RUSTINE en place 2026-06-20 ~22:11)

`dokploy-network` (10.0.1.0/24) route PARFAITEMENT (testé : `engine→dokploy-traefik:80`
= open ; l'engine y est déjà via 10.0.1.100). Fix appliqué :
```
docker network connect --alias clickhouse     dokploy-network analytics-engine-prod-gkggyk-clickhouse-1
docker network connect --alias postgres-bridge dokploy-network analytics-engine-prod-gkggyk-postgres-bridge-1
docker restart analytics-engine-prod-gkggyk-engine-1
```
→ engine joint CH:8123 via dokploy-network (`Ok.`), migrations OK,
`Staminads API v9.0.0`, health 200. ✅

## ⚠️ La rustine SAUTE au prochain redeploy

`docker network connect` est runtime : un `compose.deploy` recréera les containers
sur `engine-internal` (toujours cassé) SANS les rattacher à dokploy-network →
l'incident se répète. **NE PAS redéployer cette stack tant que le fix durable
n'est pas en place.**

## Fix durable (à coder, staging d'abord)

Options (à trancher) :
1. **Ajouter `dokploy-network` (external) au compose** comme réseau des services
   CH/postgres-bridge/engine, en plus ou à la place de `engine-internal`. Le plus
   simple : déclarer `dokploy-network: { external: true }` et y attacher les 3
   services avec alias. Élimine la dépendance au bridge cassé.
2. **Forcer un subnet différent** pour `engine-internal` (ex 172.28.0.0/16) au cas
   où 172.20.0.0/16 serait corrompu au niveau hôte — moins sûr (cause non prouvée).
3. Investiguer la cause kernel (bridge netfilter) — long, incertain.

Reco : option 1 (réseau partagé qui marche déjà). Tester sur staging, vérifier
isolation (les services restent privés, dokploy-network n'est pas exposé), puis prod.

## Postmortem / leçons
- Le rollback auto CI ne gère pas un incident réseau (a échoué aussi).
- Un deploy Dokploy bloqué peut corrompre durablement un réseau Docker.
- Diagnostic réseau : tester `nc`/`wget` inter-container + comparer à un réseau qui
  marche + tester un réseau alternatif (dokploy-network) = la clé qui a débloqué.

## MISE À JOUR — l'incident touchait AUSSI le CRM (réseau crm-internal 172.19.0.0/16)

Le CRM Twenty (`compose-parse-optical-array-lvh5md`, bridge crm-internal) avait
le MÊME bug : `crm-server→crm-postgres:5432 Operation timed out`, 502. Donc
l'incident réseau est SYSTÉMIQUE (≥2 réseaux Docker cassés simultanément :
engine-internal 172.20 + crm-internal 172.19). Probablement déclenché par le même
événement hôte (deploy bloqué / restart Docker / OOM cette nuit).

Même rustine appliquée et VALIDÉE pour le CRM :
```
docker network connect --alias crm-postgres dokploy-network <crm-postgres>
docker network connect --alias crm-redis    dokploy-network <crm-redis>
docker network connect dokploy-network <crm-worker>   # server déjà dessus
docker restart <crm-server> <crm-worker>
```
→ CRM health 200, Twenty démarré, traite les requêtes REST. ✅

⚠️ Le fix durable doit couvrir les DEUX stacks (analytics + CRM), et probablement
vérifier que d'AUTRES réseaux internes ne sont pas dans le même état latent.
Ticket à router aussi vers l'agent CRM/infra. Owner élargi : infra Veridian.
