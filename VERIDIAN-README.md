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
