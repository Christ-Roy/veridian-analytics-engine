# CI-ARCHITECTURE — Veridian Analytics Engine

> **Statut** : Phase 2 (durcissement) — 2026-05-21
> **Référence parente** : [veridian-hub CI-ARCHITECTURE.md](../../veridian-hub/docs/CI-ARCHITECTURE.md)
> **Maintainer** : agent CI/Husky hardening

Ce document décrit l'architecture CI/CD du repo `veridian-analytics-engine`
(fork staminads + bridge Veridian + console UI portée). Il est aligné sur les
conventions de `veridian-hub` (la "bible CI" Veridian) avec les adaptations
nécessaires au fork polyglotte (NestJS upstream + bridge Express + SDK TS +
console Solid + ClickHouse).

## §1. Vue d'ensemble

```
   ┌────────────────┐       ┌────────────────┐       ┌────────────────┐
   │  branche `dev` │──────▶│ branche `staging` ─────▶│ branche `main` │
   │  bac à sable   │       │ trunk prod-prep │       │ photo de prod  │
   │  hot-reload    │       │ analytics-engine│       │ analytics-eng. │
   └────────────────┘       └────────────────┘       └────────────────┘
        │                          │                          │
        ▼                          ▼                          ▼
   dev-checks.yml          staging-deploy.yml          prod-ci.yml
   (no deploy, gates)      (deploy dev-pub +           (build + Dokploy +
                            Playwright smoke +          smoke + rollback)
                            rollback auto)
```

**Trois trunks** parallèles :

| Branche | Rôle | Workflow CI | URL |
|---|---|---|---|
| `main` | Tracking staminads upstream (read-only) | `test.yml` (Jest upstream) | — |
| `dev` | Sandbox hot-reload dev-pub via Tailscale | `dev-checks.yml` | (Tailscale only) |
| `staging` | Trunk de prod-prep, deploy auto | `staging-deploy.yml` | `analytics-engine[-bridge].staging.veridian.site` |
| `veridian/main` | Ancien trunk avant rename (alias staging) | `staging-deploy.yml` | — |

> ⚠️ **`main` est staminads upstream** — ne reçoit JAMAIS de commits Veridian.
> Le hook `pre-commit` + `pre-push` refusent les commits sur cette branche.

**Note 2026-05-21** : `prod-ci.yml` est câblé mais le compose Dokploy prod
n'est pas encore créé (cf. §16 "Reste à câbler"). Le deploy-prod skip avec
warning tant que `ANALYTICS_DOKPLOY_COMPOSE_ID` n'est pas set dans les vars
GitHub Actions.

## §2. Husky hooks — qualité avant push

Trois hooks Husky bloquants. Constitution CI §3 : **jamais `--no-verify`**.

### §2.1 `pre-commit` (rapide, < 5s)

1. **`check-protected-branch.sh`** — refuse les commits sur `main` (upstream).
2. **`lint-staged.sh`** — vérifie sur les fichiers staged :
   - Pas de `console.log` ajouté sans `eslint-disable` (sauf `index.ts`).
   - Pas de megafile > 500 lignes créé ex-nihilo (warning).
   - YAML lint sur compose/ et workflows/ (yamllint si dispo).
   - Pas de secret en clair (sk_live, ghp_, AIza, AKIA) dans les lignes ajoutées.

### §2.2 `commit-msg` (instant)

Valide le format Conventional Commits :
- Format : `<type>(<scope>)?: <subject>`
- Types autorisés : `feat|fix|chore|docs|refactor|test|ci|build|perf|style|revert`
- Subject ≤ 72 chars
- Merge / revert / fixup / squash auto skip

### §2.3 `pre-push` (~30s premier run, < 10s ensuite avec node_modules)

Pipeline complet avant push :

1. **`check-protected-branch.sh`** — refuse push sur `main`.
2. **`check-conventional-commits.sh`** — valide tous les subjects du range `BASE_REF..HEAD`.
3. **`check-test-mapping.sh`** — fichier source modifié = test correspondant exigé
   (canonique ou via `test-coverage-map.yaml`).
4. **`static-audit.sh`** — scan les fichiers TS du diff :
   - Patterns CRITIQUES (bloquants) : `eval()`, `new Function()`, `exec()/execSync()`, secrets hard-codés.
   - Patterns WARNINGS : `any`, `@ts-ignore`, `TODO:SECURITY`, `console.log` de secrets, `.skip()`.
5. **`check-env-sync.sh`** — `process.env.X` dans le code = déclaré dans `.env.example`.
6. **Bridge typecheck + tests** — `tsc --noEmit` + `npm run test:ci`.
7. **`npm audit --omit=dev --audit-level=high`** sur veridian-bridge — bloquant.

### §2.4 Exception : skip d'urgence

Variables d'env :
- `SKIP_ENV_SYNC=1` — désactive le check ENV sync (rare, dette éphémère).
- `BASE_REF=<ref>` — override la branche de référence (par défaut `origin/<branche>`).

Toute utilisation = à éviter et expliquer dans le message de commit.

## §3. Workflows GitHub Actions

### §3.1 Reusable workflows (préfixe `_`)

Inspirés directement de veridian-hub :

| Workflow | Rôle | Input clés |
|---|---|---|
| `_audit-cve.yml` | npm audit prod-only, bloquant high+ | `app-path`, `level` |
| `_trivy-fs.yml` | Trivy filesystem scan (vuln+misconfig+secret) | `scan-path`, `continue-on-error` |
| `_trivy-image.yml` | Trivy image scan + SBOM CycloneDX + SARIF | `image-ref`, `continue-on-error` |

**Convention bloquant vs warn-only** :
- Bridge images → **bloquant** (`continue-on-error: false`)
- Engine images (upstream staminads) → **warn-only** (`continue-on-error: true`)
- Filesystem scan dev/staging → **warn-only** (upstream noise)
- Filesystem scan prod cron → idem warn-only mais avec issue auto si CVE

### §3.2 `dev-checks.yml` (push dev)

Pipeline rapide, **aucun deploy** :

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ bridge-checks       │  │ sdk-checks          │  │ compose-lint        │
│ tsc + npm test:ci   │  │ build + vitest      │  │ yamllint + compose  │
└─────────────────────┘  └─────────────────────┘  │ -f dev.yml config   │
                                                  └─────────────────────┘
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ static-audit        │  │ trivy-fs            │  │ audit-bridge        │
│ eval/exec/secrets   │  │ warn-only (upstream)│  │ npm audit high+     │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

Concurrency : `analytics-engine-dev-${{ github.ref }}` avec cancel-in-progress.

### §3.3 `staging-deploy.yml` (push staging)

Pipeline complet avec deploy + smoke + rollback :

| Étage | Job | Bloquant | Durée |
|---|---|---|---|
| 1 | quick-checks | ✅ | ~3min |
| 1.b | upstream-api-tests (Jest + ClickHouse) | ✅ | ~12min |
| 1.c | upstream-sdk-tests (Vitest) | ✅ | ~5min |
| 1.d | trivy-fs | ⚠ warn-only | ~3min |
| 1.e | audit-bridge | ✅ | ~3min |
| 2 | build (engine + bridge → GHCR) | ✅ | ~6min |
| 3 | deploy-staging (SSH dev-pub + compose pull + up) | ✅ | ~3min |
| 4 | e2e-staging-smoke (Playwright sur URL publique) | ✅ | ~5min |
| 5 | rollback-staging (retag :rollback + redeploy) | conditional | ~3min |

**Rollback automatique** : déclenché si `deploy-staging` OU `e2e-staging-smoke`
sort en `failure`. Force `ENGINE_IMAGE_TAG=rollback` + `BRIDGE_IMAGE_TAG=rollback`
dans le `.env` sur dev-pub, puis `docker compose up -d`. Attend healthy max 180s.

### §3.4 `prod-ci.yml` (push main)

Promotion staging → main + deploy prod + smoke + rollback.

| Étage | Job | Bloquant |
|---|---|---|
| 0 | structural-gate (staging vert ≤24h si Dockerfile/compose/etc) | ✅ |
| 1 | build prod (engine + bridge → :latest GHCR) | ✅ |
| 1.b | trivy-bridge (bloquant) | ✅ |
| 1.c | trivy-engine (warn-only) | ⚠ |
| 2 | deploy-prod (Dokploy API redeploy) | ✅ |
| 3 | e2e-prod-smoke (Playwright sur URL prod) | ✅ |
| 4 | rollback-prod (retag :rollback → :latest + redeploy) | conditional |

**Tag `:rollback`** : posé automatiquement AVANT chaque deploy (`docker tag`
sur l'image `:latest` actuelle). Permet le rollback instantané sans re-build.

> ⚠️ Le compose Dokploy prod analytics-engine **n'existe pas encore** (cf. §16).
> `deploy-prod` skip avec un warning si `ANALYTICS_DOKPLOY_COMPOSE_ID` absent.

### §3.5 `security-cron.yml` (daily 03h UTC)

Cron quotidien Trivy sur les images deployed :
- `trivy-bridge` (bloquant) → ouvre une issue GitHub si CVE HIGH/CRITICAL
- `trivy-engine` (warn-only, upstream)
- `trivy-fs-weekly` (FS scan, warn-only)

Issue idempotente : si une issue `[security-cron]` est déjà open, on l'update
plutôt que de spammer le tracker.

### §3.6 `gsc-sync-cron.yml` (daily 04h UTC) — DÉSACTIVÉ tant que A4 pas mergé

Cron pour sync Google Search Console data de tous les tenants liés.
Le workflow est présent mais **double garde-fou** tant que le ticket A4
(GSC OAuth) n'est pas en prod :

1. Le bloc `schedule:` est commenté → pas de déclenchement automatique.
2. Le job `gsc-sync` est gardé par `if: vars.GSC_SYNC_ENABLED == 'true'` →
   même un `workflow_dispatch` manuel par erreur ne fait rien tant que la
   variable repo `GSC_SYNC_ENABLED` n'est pas créée.

Pour activer quand A4 est prod-ready : décommenter le `schedule:` + créer la
variable `GSC_SYNC_ENABLED=true` dans Settings → Variables → Actions.
L'endpoint cible est `POST /api/admin/gsc/sync-all` sur le bridge.

### §3.7 `test.yml` (Jest upstream staminads)

**NON modifié par nous** — workflow upstream staminads qui tourne sur push
`main` et `dev`. Fait Jest + coverage Codecov. Sera retiré quand l'upstream
sera consolidé dans `staging-deploy.yml:upstream-api-tests`.

### §3.8 `docker-release.yml` (push tag v*)

**NON modifié par nous** — workflow upstream staminads qui push l'image
publique `pierreb/staminads:v*` sur Docker Hub. Plus utilisé côté Veridian
(on utilise GHCR `christ-roy/veridian-analytics-engine`).

## §4. Tests E2E Playwright

Stack Playwright 1.50+ ajoutée dans `veridian-bridge/`. Configuration dans
`veridian-bridge/playwright.config.ts`.

### §4.1 Structure

```
veridian-bridge/tests/e2e/
├── helpers/
│   ├── bridge-fixture.ts   # bootBridgeForTest() + bootBridgeWithStaminads()
│   └── fixtures.ts         # payloads partagés (VALID_PROVISION_PAYLOAD, etc.)
├── promise-flows/
│   ├── 01-tenant-provision.spec.ts   # provision + idempotence + HMAC
│   ├── 02-tracker-to-dashboard.spec.ts # status + score (FakeStaminads HTTP)
│   ├── 03-forms-submission.spec.ts   # B1 (skipped tant que pas mergé)
│   ├── 04-gsc-oauth.spec.ts          # A4 (skipped tant que pas mergé)
│   ├── 05-shadow-marketing.spec.ts   # endpoint public 6 services
│   └── 06-edge-cases.spec.ts         # Bearer, Zod, stack leak
└── smoke/
    ├── health-check.spec.ts          # /health 200 + JSON
    └── cold-start.spec.ts            # boot < 5s
```

**Deux fixtures de boot** (`helpers/bridge-fixture.ts`) :

- **`bootBridgeForTest()`** — bridge isolé, hook `createStaminadsWorkspace`
  mocké. Suffit aux routes HMAC `/api/tenants/*` et aux endpoints publics.
  Les routes admin staminads-backed (`/status`, `/score`) renvoient 500 dans
  ce mode (staminads injoignable) — ne pas les tester ici.
- **`bootBridgeWithStaminads()`** — bridge câblé sur un `FakeStaminads` HTTP
  réel. Obligatoire pour `/api/admin/tenant/:id/status|score|analytics`. Le
  test pilote staminads via `fixture.staminads!.setBehavior({...})`.

### §4.2 Modes d'exécution

- **Local** : `cd veridian-bridge && npm run test:e2e` — boot bridge + faux staminads sur ports éphémères.
- **CI staging smoke** : `BRIDGE_URL=https://analytics-engine-bridge.staging.veridian.site npm run test:e2e:smoke`.
- **CI prod smoke** : `BRIDGE_URL=https://analytics-engine-bridge.app.veridian.site npm run test:e2e:smoke`.

Les specs `promise-flows/` boot toujours un bridge local (déterministes, rapides).
Les specs `smoke/` détectent `BRIDGE_URL` et basculent en mode remote.

### §4.3 Test.skip() pour endpoints pas montés dans le fixture

Les specs `03-forms-submission` et `04-gsc-oauth` sont en `test.describe.skip()`.

**Subtilité 2026-05-22** : B1 (forms) et A4 (gsc) SONT mergés sur `dev`
(`src/forms/`, `src/gsc/` + couverture unité dédiée). MAIS leurs routes sont
montées par `registerFormsRoutes()` / `registerGscRoutes()` dans `index.ts`,
**pas** dans `createApp()`. Le fixture E2E (`bootBridgeForTest` /
`bootBridgeWithStaminads`) utilise `createApp` seul → ces routes répondent
404 en E2E.

Pour activer ces specs :

1. Étendre `bridge-fixture.ts` : appeler `registerFormsRoutes` /
   `registerGscRoutes` avec un FakePrisma (cf. `tests/helpers/fake-prisma-forms.ts`).
2. Retirer `test.describe.skip` → `test.describe`.
3. Vérifier que les tests passent en local + en CI staging.

En attendant, la couverture unité B1 (`tests/forms/*`) et l'intégration A4
(`tests/integration/gsc-end-to-end.test.ts`) restent la source de vérité.

## §5. Test-mapping route↔test

Géré par `scripts/ci/check-test-mapping.sh` (exécuté par pre-push + CI).

### §5.1 Convention canonique

| Source | Test attendu |
|---|---|
| `veridian-bridge/src/*.ts` | `veridian-bridge/tests/*.test.ts` |
| `api/src/*/x.service.ts` | `api/src/*/x.service.spec.ts` (Jest unit) |
| `api/src/*/x.controller.ts` | `api/test/x.e2e-spec.ts` (Jest e2e) |
| `sdk/src/*.ts` | `sdk/tests/*.spec.ts` (Vitest) |

### §5.2 Fallback : `test-coverage-map.yaml`

Si la convention canonique ne suffit pas, déclarer explicitement dans
`test-coverage-map.yaml` :

```yaml
- sources:
    - veridian-bridge/src/foo.ts
  covered_by:
    - veridian-bridge/tests/foo-aspect-a.test.ts
    - veridian-bridge/tests/foo-aspect-b.test.ts
  reason: |
    foo.ts a deux aspects testés séparément (factory + middleware).
```

### §5.3 Dette transitoire : `tests-pending.txt`

Si un fichier critique n'a pas (encore) de test, l'ajouter à `tests-pending.txt`
avec une date limite de résolution. Le check accepte temporairement, mais le
backlog est visible.

## §6. Policy CVE

| Scope | Sévérité bloquante | Action |
|---|---|---|
| `veridian-bridge` (npm) | HIGH + CRITICAL | bump deps, refuser merge |
| `veridian-bridge` (image) | HIGH + CRITICAL avec fix | bump base image |
| `api` (staminads upstream) | warn-only | suivre upstream + ignore via `.trivyignore` doc |
| `sdk` (npm) | HIGH + CRITICAL | bump deps |
| Engine image (staminads) | warn-only | issue tracker upstream |

`.trivyignore` racine doc les CVE engine ignorées avec justification.
`veridian-bridge/.trivyignore` doc les CVE bridge avec justification.

**Convention** : une CVE ne s'ajoute à `.trivyignore` que si :
1. Pas de fix dispo upstream (vérifié via `npm audit` ou GHSA)
2. Mitigée par un mécanisme explicite (filtre, sanitization, scope limité)
3. Documentée avec lien CVE + raison + date

## §7. Policy rollback

### §7.1 Staging

Auto-rollback sur fail `deploy-staging` ou `e2e-staging-smoke`.
Tag `:rollback` posé avant chaque deploy → restore en 1 step + redeploy compose.

### §7.2 Prod

Auto-rollback sur fail `deploy-prod` ou `e2e-prod-smoke`.
Skip rollback si `workflow_dispatch.skip-rollback=true` (debug uniquement).

### §7.3 Manual override

Robert peut intervenir à tout moment via les mots-clés du protocole §20 Hub
(`stop` / `rollback` / `freeze`). Ici on l'applique de manière équivalente :
push direct sur `staging` avec un revert commit + re-déclenche le pipeline.

## §8. Promotion staging → main (auto-promote graduée)

**Non implémentée pour l'instant côté analytics-engine** — la promotion se
fait manuellement par Robert avec :

```bash
git checkout main
git merge --ff-only origin/staging
git push origin main
```

Quand le trafic réel justifie le durcissement, on alignera sur le pattern
`promote-to-main` de Hub (§20 CI-ARCHITECTURE Hub) avec marker `[risk:low]`.

## §9. Convention de branches

- **`main`** : staminads upstream — read-only côté Veridian.
- **`staging`** : trunk de prod-prep — recevra les commits prêts à shipper.
- **`dev`** : sandbox hot-reload sur dev-pub (Tailscale) — branche de travail des agents.
- **`feat/<slug>`** : branche feature, mergée dans `dev` puis `staging`.
- **`fix/<slug>`** : branche fix, idem.
- **`chore/<slug>`** : branche chore (ce ticket = `chore/ci-husky-hardening`).

**Workflow agent** :
1. Créer `chore/<slug>` depuis `origin/dev`
2. Bosser dessus (commits Conventional Commits)
3. Push → CI dev-checks tourne
4. Merge `dev` (ff-only) → CI re-tourne sur dev
5. Robert valide + merge `dev` → `staging` → CI staging tourne (deploy + smoke)
6. Robert promote `staging` → `main` quand prêt

## §10. Concurrency policy

| Workflow | Group | cancel-in-progress |
|---|---|---|
| `dev-checks.yml` | `analytics-engine-dev-${{ ref }}` | true (cancel old runs sur même ref) |
| `staging-deploy.yml` | `analytics-engine-${{ ref }}` | true |
| `prod-ci.yml` | `analytics-engine-prod-${{ ref }}` | **false** (prod = sérialisé) |
| `security-cron.yml` | — | — |

Prod = `cancel-in-progress: false` pour ne PAS cancel un deploy mi-vol.

## §11. Secrets GitHub Actions

| Secret | Scope | Usage |
|---|---|---|
| `DEPLOY_SSH_KEY` | repo | clé `staging-deploy@37.187.199.185` (dev-pub) |
| `CLICKHOUSE_PASSWORD_STAGING` | repo | mot de passe ClickHouse staging |
| `ENCRYPTION_KEY_STAGING` | repo | clé de chiffrement staging |
| `STAMINADS_ADMIN_PASSWORD_STAGING` | repo | admin staminads staging |
| `VERIDIAN_ADMIN_API_KEY_STAGING` | repo | Bearer admin staging |
| `HUB_HMAC_SECRET_ANALYTICS_STAGING` | repo | HMAC partagé Hub ↔ bridge staging |
| `GITHUB_TOKEN` | auto | push GHCR + issue create |

Vars (non-secret, mais env-spécifique) :
- `PROD_VPS_HOST`, `PROD_VPS_USER` (cf. veridian-hub `VPS_HOST` / `VPS_USER`)
- `ANALYTICS_DOKPLOY_COMPOSE_ID` (à set quand compose prod créé)

## §12. paths-ignore commun

Les workflows ignorent les changements purement docs/todo :

```yaml
paths-ignore:
  - '**.md'
  - 'docs/**'
  - 'releases/**'
  - 'TODO.md'
  - 'todo/**'
```

> Note : `_*.yml` reusable workflows ne sont jamais déclenchés directement,
> donc pas de paths-ignore nécessaire dessus.

## §13. Permissions par défaut

```yaml
permissions:
  contents: read
  packages: write          # build GHCR
  security-events: write   # upload SARIF Trivy
```

Pas de `actions: write` sauf si on déclenche un autre workflow (`gh workflow run`).
Pas de `issues: write` sauf dans les jobs cron qui ouvrent des issues.

## §14. Architecture multi-package

```
veridian-analytics-engine/
├── api/             (NestJS staminads upstream — package npm)
├── sdk/             (tracker JS upstream — package npm)
├── console/         (Solid UI upstream + composants Veridian portés — package npm)
├── veridian-bridge/ (notre couche Express auth + provisioning — package npm)
└── compose/         (docker-compose stack)
```

Chaque package a son `package.json` + `package-lock.json` indépendant.
Pas de workspace npm/pnpm. Build et release séparés (engine vs bridge GHCR).

## §15. Tooling

- **Node** : 22 partout (cohérent avec staminads upstream + dev-pub).
- **npm** : pas de pnpm sur ce repo (staminads upstream est sur npm).
- **TypeScript** : 5.7+.
- **Playwright** : 1.50+.
- **Trivy action** : `aquasecurity/trivy-action@0.36.0`.

## §16. Reste à câbler (post-merge sur dev)

| Item | Owner | Priorité |
|---|---|---|
| Compose Dokploy prod analytics-engine | infra-dokploy | 🟡 P1 |
| `ANALYTICS_DOKPLOY_COMPOSE_ID` GitHub var | infra-dokploy | 🟡 P1 |
| `PROD_VPS_HOST` / `PROD_VPS_USER` GitHub vars | infra-dokploy | 🟡 P1 |
| `HUB_HMAC_SECRET_ANALYTICS_STAGING` GitHub secret | Robert | 🟡 P1 |
| Activer `gsc-sync-cron.yml` quand A4 prod-ready | agent A4 | 🟢 P2 |
| Retirer `test.skip()` sur 03-forms / 04-gsc quand B1/A4 mergés | agents B1/A4 | 🟢 P2 |
| Migrer auto-promote staging → main type Hub §20 | post-trafic réel | 🔵 P3 |

## §17. Self-validation

Chaque workflow modifié déclenche son propre run :
- `dev-checks.yml` runs sur push dev (donc lui-même se self-test).
- `staging-deploy.yml` runs sur push staging (idem).
- Reusable `_*.yml` sont validés par leur premier caller.

Le repo `actionlint` run en CI (via `quick-checks` étage 1) catch les
syntax errors de workflows avant deploy.

## §18. Constitution CI Veridian (rappel)

1. **JAMAIS `--no-verify`** sur git push.
2. **JAMAIS `git commit -n`** pour bypass commit-msg.
3. **JAMAIS désactiver un check existant** sans remplacement par un meilleur.
4. **Pre-push lent = on optimise**, pas on désactive.
5. **Chaque modif de fichier source = test correspondant exigé** (ou déclaration coverage-map).
6. **CVE high/critical bloque** — on patch avant deploy.
7. **Audit static eval/exec/secrets** ne pardonne rien.

## §19. Changelog

- **2026-05-21** — Phase 2 (CI/Husky hardening) :
  - Ajout `pre-commit` (lint-staged) + `commit-msg` (conventional commits).
  - Durcissement `pre-push` : conv. commits + static-audit + env-sync + npm audit.
  - Refonte `dev-checks.yml` : étages quick/static-audit/trivy-fs/audit-bridge.
  - Refonte `staging-deploy.yml` : 5 étages + rollback auto + Playwright smoke.
  - Création `prod-ci.yml` : structural-gate + build prod + deploy + smoke + rollback.
  - Création workflows réutilisables `_audit-cve` / `_trivy-fs` / `_trivy-image`.
  - Création `security-cron.yml` (daily Trivy + issue auto).
  - Création `gsc-sync-cron.yml` (désactivé, prêt pour A4).
  - 8 fichiers de specs E2E Playwright (6 promise-flows + 2 smoke),
    50 tests dont 10 `skip` en attente de B1/A4.
  - Doc CI-ARCHITECTURE (ce fichier).

- **2026-05-18** — Phase 1 (POC initial) :
  - Pre-push minimal (test-mapping + tsc + tests).
  - `dev-checks.yml` / `staging-deploy.yml` / `docker-release.yml` / `test.yml`.
  - `test-coverage-map.yaml`.

---

**Source de vérité** : ce fichier. Toute évolution doit être documentée ici
ET cohérente avec `veridian-hub/docs/CI-ARCHITECTURE.md` (la "bible CI"
Veridian).
