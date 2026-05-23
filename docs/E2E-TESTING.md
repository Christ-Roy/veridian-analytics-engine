# E2E Testing — Veridian Analytics Engine

> Batterie de tests Playwright qui tape **directement les URLs LIVE** de
> staging/prod/démo. Aucun build local, aucune stack locale.

## Vue d'ensemble

15 dossiers de tests prévus dans `tests/e2e/` (cf ticket
`todo/sprint-2026-05-22-mega/E2E-TEST-BATTERY.md`). Phase 1+2 livrés :

| Dossier | Statut | Couverture |
|---|---|---|
| `01-smoke/` | ✅ Livré | healthcheck, routes reachable, SSL cert, security headers, console JS clean |
| `02-tracker-to-dashboard/` | ⏳ Phase 3 | — |
| `03-forms-leads/` | ⏳ Phase 3 | — |
| `04-push-pwa/` | ⏳ Phase 4 | — |
| `05-gsc-oauth/` | ⏳ Phase 4 | — |
| `06-hub-contract/` | ✅ Livré | HMAC rejection (5 scenarios) + HMAC valid provision (staging uniquement) |
| `07-settings-credentials/` | ⏳ Phase 4 | — |
| `08-voip-calls/` | ⏳ Phase 4 | — |
| `09-dashboard-ui/` | ⏳ Phase 3 | — |
| `10-onboarding-wizard/` | ⏳ Phase 4 | — |
| `11-demo-public/` | ✅ Livré | accessible, banner CTA, restricted guards, re-seed (demo-staging only) |
| `12-auth-flow/` | ⏳ Phase 4 | — |
| `13-cross-app/` | ⏳ Phase 4 | — |
| `14-perf-regression/` | ⏳ Phase 4 | squelette workflow OK |
| `15-chaos/` | ⏳ Phase 4 | — |

## Workflows CI

| Workflow | Trigger | Cibles | Bloquant ? |
|---|---|---|---|
| `e2e-smoke-staging.yml` | post-deploy staging (workflow_run) | staging | oui (issue auto) |
| `e2e-smoke-prod.yml` | post-deploy prod (workflow_run) | prod + demo-prod | oui (issue urgente + rollback manuel) |
| `e2e-full-staging.yml` | nightly 02:00 UTC + manual | staging + demo-staging | non (warn + issue) |
| `e2e-visual-regression.yml` | weekly Sunday 03:00 UTC + manual | staging | non |

## Structure

```
tests/e2e/
├── playwright.config.ts        # config + 3 projets (chromium-desktop, mobile, webkit)
├── package.json                # deps Playwright isolées
├── tsconfig.json
├── fixtures/
│   └── test-data.ts           # makeTestEmail, makeProvisionPayload, etc.
├── helpers/
│   ├── targets.ts             # URL résolution staging/prod/démo
│   ├── api-client.ts          # wrapper fetch avec timeout + JSON
│   ├── hub-hmac.ts            # signature HMAC pour requêtes Hub→bridge
│   ├── ssl.ts                 # tls.connect pour récupérer le cert
│   └── retry.ts               # pollUntil(...) pour async ClickHouse
├── 01-smoke/                  # ≤ 60s, bloquant CI
├── 06-hub-contract/           # HMAC + provision
└── 11-demo-public/            # démo guards + accessibility
```

## Cibles testées

| Target name | Console URL | Engine URL | Bridge URL |
|---|---|---|---|
| `staging` | `analytics-engine.staging.veridian.site` | (idem) | `analytics-engine-bridge.staging.veridian.site` |
| `prod` | `analytics-engine.app.veridian.site` | (idem) | `analytics-engine-bridge.app.veridian.site` |
| `demo-prod` | `demo-analytics.veridian.site` | (idem) | (interne, non public) |
| `demo-staging` | `demo-staging-analytics.veridian.site` | (idem) | (interne, non public) |

Sélection via env `TARGET=<name>` (default: `staging`).

## Comment lancer en local

**⚠️ INTERDIT en local sur la machine de Robert** (RAM 7.6Gi). Les tests doivent
tourner **uniquement en CI GitHub Actions** ou via `ssh dev-pub`.

Sur dev-pub :

```bash
ssh dev-pub
cd /opt/e2e-tests   # ou clone temporaire
cd tests/e2e
npm install
npx playwright install --with-deps chromium
TARGET=staging npx playwright test 01-smoke/
```

Pour tester un dossier précis :

```bash
TARGET=staging npx playwright test 01-smoke/healthcheck.spec.ts
TARGET=demo-prod npx playwright test 11-demo-public/demo-accessible.spec.ts
HUB_HMAC_SECRET=<secret-staging> TARGET=staging npx playwright test 06-hub-contract/
```

## Conventions

### Préfixes obligatoires

- Tout workspace créé pendant un test → `e2e-test-<uuid>`
- Tout email de test → `e2e-test-<id>@veridian-test.local` (TLD non routable)
- Tout tenant Hub ID → `hub_tnt_e2e_<id>`
- Cleanup à la fin de chaque suite (à câbler quand on aura un endpoint cleanup)

### Mocks externes obligatoires

- Google OAuth → mocker
- Telnyx → mocker
- OVH Telephony → mocker
- web-push → mocker
- Brevo / Notifuse emails → mocker (jamais d'envoi réel)

### Secrets

| Secret CI | Usage |
|---|---|
| `HUB_HMAC_SECRET_ANALYTICS_STAGING` | provision/attach HMAC contre staging |
| `DEMO_SECRET_ANALYTICS_STAGING` | re-seed démo staging |
| (jamais commit) `HUB_HMAC_SECRET_ANALYTICS` | **PROD — JAMAIS en CI test, lecture seule pour debug** |

## Debug d'un test cassé

1. Aller sur l'artifact `playwright-report-*` du run GitHub
2. Télécharger, ouvrir `playwright-report/index.html` localement
3. Inspecter trace + screenshot + video (capturés `retain-on-failure`)
4. Si rejouer en local nécessaire → SSH dev-pub, pas le PC de Robert

## Update des golden snapshots (Phase 4)

Quand 14-perf-regression sera implémenté :

```bash
gh workflow run e2e-visual-regression.yml -f update-snapshots=true
```

Crée une PR auto avec les nouvelles golden — review humaine OBLIGATOIRE.

## Définition de "terminé" (extrait du ticket)

- [x] Phase 1 : `01-smoke` complet, workflow staging + prod actifs
- [x] Phase 2 : `06-hub-contract` (5 rejections + 3 provision tests) + `11-demo-public` (4 specs)
- [ ] Phase 3 : `02-tracker-to-dashboard`, `03-forms-leads`, `09-dashboard-ui`
- [ ] Phase 4 : `04-push`, `05-gsc`, `07-settings`, `08-voip`, `10-onboarding`, `12-auth`, `13-cross-app`, `14-visual`, `15-chaos`
- [x] Workflows CI : `e2e-smoke-staging.yml`, `e2e-smoke-prod.yml`, `e2e-full-staging.yml`, `e2e-visual-regression.yml`
- [x] Doc `docs/E2E-TESTING.md`

## Frictions connues

- `playwright install` télécharge ~300MB de Chromium → cold start CI ~1 min
- Tests `demo-prod` peuvent flaker pendant un re-seed cron (collision) → on a mis
  les retry à 2 en CI
- Le `webkit-desktop` project est défini mais pas utilisé encore (Phase 4)
