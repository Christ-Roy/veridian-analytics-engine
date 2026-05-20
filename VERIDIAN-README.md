# Veridian Analytics Engine

Fork interne de [staminads](https://github.com/staminads/staminads) v6.1.0, adapté pour
Veridian SaaS multi-tenant.

> 📍 **README upstream** : voir `README.md` pour la doc générale staminads.
> 📍 **Patches Veridian** : voir `PATCHES.md`.

## Stack

- **Backend** : NestJS + TypeScript
- **Database** : ClickHouse (sub-50ms queries, partitionnée par jour)
- **Frontend** : React + Ant Design (console embarquée)
- **SDK** : staminads SDK + patches Veridian (visitor_id)

## URLs Veridian

| Env | URL | Branche |
|---|---|---|
| Staging | https://analytics-engine.staging.veridian.site | `staging` |
| Prod | https://analytics-engine.app.veridian.site | `main` |

## Architecture two-tier

```
veridian-analytics (Next.js, ce repo séparé)
    └─ Auth Veridian, intégration Hub, GSC, magic links
    └─ HTTP →  veridian-analytics-engine (CE repo, fork staminads)
                └─ Ingestion ClickHouse + dashboards + AI assistant
```

Le repo `veridian-analytics` (séparé) reste la **couche métier Veridian**. Ce fork ne reçoit
que les patches techniques (visitor_id, branding console).

## Quick start dev local

```bash
docker compose -f compose.yaml up -d
# Web UI : http://localhost:3000
# Init admin : POST /api/setup.initialize
```

## Env DEV hot-reload sur dev-pub (Traefik staging-edge, tailnet only)

But : itérer vite sans payer 5 min de build CI à chaque modif. Le code est
bind-monté depuis dev-pub, NestJS + tsx tournent en watch.

```bash
# 1. Bosse en local sur la branche `dev`, push.
git checkout dev
# ... modifs ...
git push origin dev

# 2. Sur dev-pub, déclenche le sync + reload :
ssh dev-pub 'bash /opt/dev/analytics-engine/scripts/dev-up.sh'
```

URLs (joignables depuis n'importe quelle machine sur le tailnet — wildcard
`*.staging.veridian.site` → IP dev-pub privée, pas d'exposition Internet) :

| Service | URL |
|---|---|
| Engine + console (NestJS) | `https://analytics-engine-dev.staging.veridian.site/` |
| Engine API setup status | `https://analytics-engine-dev.staging.veridian.site/api/setup.status` |
| Bridge Veridian health | `https://analytics-engine-bridge-dev.staging.veridian.site/health` |

Une fois la stack up, modifier un `.ts` côté `api/src/` ou `veridian-bridge/src/`
recompile et redémarre tout seul (~1-2s NestJS, ~500ms bridge).

**Logs live** :
```bash
ssh dev-pub 'docker logs -f analytics-engine-dev'
ssh dev-pub 'docker logs -f analytics-engine-dev-bridge'
```

**Stop** :
```bash
ssh dev-pub 'bash /opt/dev/analytics-engine/scripts/dev-down.sh'   # garde volumes
```

CI sur push `dev` : quick checks uniquement (bridge typecheck + tests, SDK
vitest, compose lint). **Pas de build d'image GHCR, pas de deploy** — c'est
exprès, on dev sur dev-pub directement.

## Deploy staging

Auto-deploy sur push `staging` : GHCR build → SSH dev-pub → `docker compose pull && up -d`.

## Deploy prod

Auto-deploy sur push `main` : GHCR build → Trivy scan → SSH prod-pub via Dokploy API.

## Tests

Suite staminads upstream (Jest unit + e2e ClickHouse) **non modifiée**. Ajout de tests
Veridian-spécifiques dans `api/test/veridian/` au fur et à mesure des patches.

```bash
cd api && npm test                 # unit
cd api && npm run test:e2e         # e2e ClickHouse
```

## Conformité AGPL

- Fork interne, pas de redistribution publique
- Si un client SaaS demande la source : lui fournir (voir `PATCHES.md`)
