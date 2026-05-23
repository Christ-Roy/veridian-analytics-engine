# E2E Testing — Veridian Analytics Engine

> Batterie de tests Playwright qui tape **directement les URLs LIVE** de
> staging/prod/démo. Aucun build local, aucune stack locale.

## Vue d'ensemble

15 dossiers de tests prévus dans `tests/e2e/`. Phase 1+2 livrés + Phase A/B/C
(anti-régression bugs P0 + flows métier + UI dashboard) livré 2026-05-23 :

| Dossier | Statut | Couverture |
|---|---|---|
| `01-smoke/` | ✅ Livré | healthcheck, routes reachable, SSL cert, security headers, console JS clean |
| `02-bugs-regression/` | ✅ Livré (2026-05-23) | 9 specs anti-régression bugs bug-hunter (BUG-01/02/03/04/05/06/08/09/10/11/12/13/20/21) |
| `02-tracker-to-dashboard/` | ✅ Livré (2026-05-23) | `/api/track` accepts payload + bridge score/status endpoint shape |
| `03-forms-leads/` | ✅ Livré (2026-05-23) | `/api/ingest/form` validation + CORS + happy path gated |
| `04-push-pwa/` | ⏳ Phase D | — |
| `05-gsc-oauth/` | ⏳ Phase D | — |
| `06-hub-contract/` | ✅ Livré | HMAC rejection (5 scenarios) + HMAC valid provision (staging uniquement) |
| `07-settings-credentials/` | ⏳ Phase D | — |
| `08-voip-calls/` | ⏳ Phase D | — |
| `09-dashboard-ui/` | ✅ Livré (2026-05-23) | dashboard sections render + mobile responsive |
| `10-onboarding-wizard/` | ⏳ Phase D | — |
| `11-demo-public/` | ✅ Livré | accessible, banner CTA, restricted guards, re-seed (demo-staging only) |
| `12-auth-flow/` | ⏳ Phase D | — |
| `13-cross-app/` | ⏳ Phase D | — |
| `14-perf-regression/` | ⏳ Phase D | squelette workflow OK |
| `15-chaos/` | ⏳ Phase D | — |

### Tags & grep

- `@critical` : flows métier + bugs P0 — bloquant pour smoke staging/prod
- `@bug-XX` : anti-régression d'un bug identifié (chaque test mappé sur 1+ bug)
- `@mobile` : grep `chromium-mobile` project
- `@webkit` : grep `webkit-desktop` project

### Auto-création d'issues GitHub

Le script `scripts/ci/e2e-report-to-issues.mjs` parse `test-results/results.json`
(Playwright JSON reporter, activé en CI dans `playwright.config.ts`) et :

1. Pour chaque test rouge `@critical` ou `@bug-XX` : crée une issue GitHub
   avec titre `E2E regression: <test name>`, label `e2e-regression` + `p0/p1`
   + cible. Idempotent — pas de doublon.
2. Pour chaque test précédemment rouge qui repasse vert : ferme l'issue avec
   commentaire "Fixed by CI run #XXX".

Câblé dans les 3 workflows E2E (`always()` step). Les agents qui veulent
prendre du travail filtrent les issues avec label `e2e-regression`.

### Secrets GitHub requis pour le full nightly

- `E2E_BRIDGE_ADMIN_TOKEN_STAGING` — token admin Bearer pour `/api/admin/tenant/*` du bridge
- `E2E_BRIDGE_TEST_WORKSPACE_ID_STAGING` — workspace de test connu côté bridge
- `E2E_TEST_WORKSPACE_ID_STAGING` — workspace UI dashboard pour pages render checks
- `E2E_ADMIN_EMAIL_STAGING` / `E2E_ADMIN_PASSWORD_STAGING` — login admin staging (futurs tests auth)
- `E2E_TEST_SITE_KEY_STAGING` — siteKey valide pour happy-path ingest form
- `HUB_HMAC_SECRET_ANALYTICS_STAGING` — déjà existant pour 06-hub-contract
- `DEMO_SECRET_ANALYTICS_STAGING` — déjà existant pour 11-demo-public re-seed

Si manquants → les tests concernés `test.skip()` proprement (jamais d'erreur).

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
