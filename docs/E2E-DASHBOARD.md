# E2E Dashboard — Veridian Analytics Engine

> **Statut** : 🟢 Gate on-premise réparé (2026-06-23) — specs mortes purgées
> **Total specs** : 61 specs réparties sur 18 dossiers
> **Couverture** : focus P0/P1 sur le scope commercialisé (vision 2026-05-23)

## 🚦 LE GATE avant prod — `00-gate-onpremise`

**Le rempart E2E on-premise.** Avant toute promotion `staging → main`, le
workflow **`e2e-gate-onpremise.yml`** (déclenché AUTO sur push `staging`) doit
être **vert**. Il teste le vrai scope commercialisé de bout en bout contre le
staging RÉEL (ClickHouse réel, via l'API M2M `POST /api/admin/platform/*`) :

1. **Tracking / visiteurs** : provision → snippet → ingestion round-trip
   ClickHouse (`tracking.verify` dry-run + purge) → `/api/track` public →
   `analytics.query` requêtable.
2. **Calls / VoIP** : `voip.addPhoneNumber` + `voip.listPhoneNumbers` (numéro par source).
3. **Search Console** : `gsc.status` (connecteur câblé).

Self-contained + idempotent : crée son workspace jetable (`e2e_gate_*`), le
purge en fin de run (super-admin `workspaces.delete`), zéro pollution.

> **Où tourne le gate** : staging est derrière Tailscale (`*.staging.veridian.site`
> → IP Tailnet `100.64.0.0/10`), donc un runner GitHub public ne peut pas
> l'atteindre (c'est la raison de fond pour laquelle tous les ex-E2E staging
> cancellaient/skippaient). Le gate s'exécute via le script bash
> `tests/e2e/00-gate-onpremise/gate-scenario.sh`, lancé **sur dev-pub** par le
> workflow (SSH, pattern éprouvé de `staging-deploy.yml`). dev-pub est sur le
> tailnet et atteint l'engine en local. La spec Playwright `.ts` jumelle reste
> le reflet typé, utilisable à la main depuis le tailnet.

> **Comment l'utiliser comme gate** : `gh run watch` sur `e2e-gate-onpremise.yml`
> après push staging. Vert → promote `main`. Rouge → freeze, on ne promote pas.
> Relance manuelle : `gh workflow run e2e-gate-onpremise.yml`. À la main depuis
> le tailnet : `cd tests/e2e && PLATFORM_ADMIN_API_KEY=… TARGET=staging npm run test:gate`.

## Vue d'ensemble

Cette doc agrège l'état de la batterie E2E. Référencée dans
`e2e-report-to-issues.mjs`.

## Suite par dossier

| Dossier | Specs | Statut | Bloquant CI | Workflow |
|---|---|---|---|---|
| `00-gate-onpremise` | 1 | 🟢 **GATE** (provision→track→ClickHouse→VoIP→GSC) | **OUI — gate prod** | **gate-onpremise (push staging)** |
| `01-smoke` | 5 | 🟢 OK | OUI prod + staging | smoke-staging / smoke-prod |
| `02-bugs-regression` | 9 | 🟢 OK (anti-régression 14 bugs) | OUI prod + staging | smoke-staging / smoke-prod |
| `02-tracker-to-dashboard` | 5 | 🟢 Partiel (track + visitor + batch + cors) | OUI staging | full-staging |
| `05-gsc-oauth` | 1 | 🟡 Partiel (endpoints + CSRF + sync gate) | NON | full-staging nightly |
| `06-hub-contract` | 1 | 🟢 OK (HMAC rejection — sécurité) | OUI prod | smoke-staging / smoke-prod |
| `07-settings-credentials` | 1 | 🟡 Partiel (page + voip credentials shape) | NON | full-staging nightly |
| `08-voip-calls` | 1 | 🟡 Partiel (endpoints shape + UI smoke) | NON | full-staging nightly |
| `09-dashboard-ui` | 5 | 🟢 OK (sections + mobile + responsive + tabs + empty) | OUI staging | full-staging |
| `10-onboarding-wizard` | 1 | 🟡 Partiel (welcome route + tracker.detect) | OUI staging | full-staging |
| `11-demo-public` | 6 | 🟢 OK (existant + extensions) | OUI prod | smoke-staging / smoke-prod |
| `12-auth-flow` | 5 | 🟢 OK (login/error pages/logout/JWT/setup) | OUI prod | security-audit nightly |
| `14-perf-regression` | 2 | 🟡 Partiel (vitals + bundle + visual snapshot) | NON | perf-regression hebdo |
| `15-chaos` | 1 | 🟡 Partiel (observability stable + burst) | NON | perf-regression hebdo |
| `16-security` | 7 | 🟢 OK (headers/CORS/admin/inject/secrets/HMAC/rate) | NON (nightly) | security-audit nightly |
| `17-multi-tenant-isolation` | 3 | 🟢 OK (cross-tenant + api-key + deletion) | OUI staging | security-audit nightly |
| `18-api-contract` | 2 | 🟢 OK (shape stable + version diag) | OUI staging | security-audit nightly |
| `19-sdk-tracker` | 2 | 🟢 OK (bundle + init + CSP) | OUI staging | full-staging |
| `21-anti-regression-2026-05-25` | 3 | 🟢 OK (setup-locked + helmet + FR) | OUI prod | smoke-prod / security-audit |

**Supprimés 2026-06-23** (features mortes vision 2026-05-23 + bridge décommissionné) :
`03-forms-leads` (forms supprimés), `04-push-pwa` (push archivé),
`13-cross-app-inbound` (tapait le bridge mort), `20-business-flows`
(bridge + `/api/ingest/form` périmé), 3 specs de `06-hub-contract`
(`hmac-valid-provision`/`idempotency-key`/`paywall-states` — écriture bridge).
Le parcours métier réel est repris, en mieux, par `00-gate-onpremise` (M2M natif).

**Légende statut** :
- 🟢 OK : couverture suffisante pour la commercialisation
- 🟡 Partiel : couvre l'essentiel, à enrichir en P3
- 🔴 Manquant : à livrer avant commercialisation

## Workflows CI actifs

| Workflow | Trigger | Suites |
|---|---|---|
| `e2e-gate-onpremise.yml` | **GATE** — push `staging` + dispatch | **00-gate-onpremise (bloquant prod)** |
| `e2e-smoke-staging.yml` | workflow_run après Staging CI/CD + cron 3x/j | 01 + 06-rejection + 02-bugs |
| `e2e-smoke-prod.yml` | workflow_run après Prod CI/CD | 01 + 02-bugs + 06-rejection + 21 (+ démo) |
| `e2e-full-staging.yml` | Nightly 02:00 UTC | suites vivantes (sauf perf/chaos) |
| `e2e-visual-regression.yml` | Hebdo dimanche 03:00 | 14-perf visual snapshots |
| `e2e-perf-regression.yml` | Hebdo lundi 04:00 | 14-perf (web vitals + bundle) |
| `e2e-security-audit.yml` | Nightly 03:00 | 12 + 16 + 17 + 18 + 21 |

## Auto-création d'issues

Le script `scripts/ci/e2e-report-to-issues.mjs` est câblé dans **tous** les
workflows et :

1. Parse `tests/e2e/test-results/results.json` (JSON reporter Playwright)
2. Pour chaque test rouge avec tag `@critical` ou `@bug-XX` :
   - Crée une issue GitHub idempotente (titre = `E2E regression: ...`)
   - Labels : `e2e-regression` + `p0`|`p1` + `<target>` + `bug` + `@bug-XX` si présent
3. Pour chaque test précédemment rouge qui repasse vert :
   - Ferme l'issue avec commentaire "Fixed by CI run #..."
4. Tag `@critical` → priorité P0 (security-audit failure ouvre umbrella issue)

**Tester l'auto-création** : injecter un test rouge avec tag `@critical`
dans n'importe quel dossier, push → le run nightly suivant doit créer une
issue.

## Tags utilisés

- `@critical` — Test bloquant prod (P0 issues)
- `@bug-XX` — Anti-régression pour BUG-XX
- `@security` — Test de sécurité (P0 issues)
- `@tracker` — Suite tracker ingestion
- `@forms` — Suite forms-leads
- `@auth` — Auth/login/JWT
- `@push` — Push notifications PWA
- `@gsc` — Google Search Console
- `@voip` — VoIP / téléphonie
- `@settings` — Settings page + credentials
- `@ui` — Dashboard UI render
- `@onboarding` — Welcome wizard
- `@contract` — API contracts stables
- `@sdk` — SDK tracker JS
- `@business` — Business flows bout-en-bout
- `@perf` — Performance / Web Vitals
- `@chaos` — Scénarios dégradés
- `@demo` — Spec démo publique
- `@branding` — Branding Veridian (pas de leak staminads)
- `@visual` — Visual regression
- `@mobile` — Test mobile (375px)
- `@webkit` — Compat Safari

## Comment ajouter une nouvelle spec

1. Choisir le dossier `tests/e2e/<NN-NOM>/` correspondant
2. Créer `<feature>.spec.ts` en suivant le pattern existant
3. Toujours tagger `@<categorie>` + `@critical` si bloquant
4. Si test contre une cible spécifique → utiliser `getTarget(TARGET)`
5. Si besoin de secret manquant → `test.skip()` propre (pas error)
6. Pas de `console.log` dans les specs — utiliser les assertions Playwright

## Comment ouvrir un dossier à 80%

Pour passer un dossier 🟡 → 🟢 :

1. Lire le scope dans `todo/sprint-2026-05-22-mega/TURBO-E2E-ANALYTICS-SCOPE.md`
2. Implémenter les specs manquantes en suivant les patterns du dossier
3. S'assurer que chaque spec a un tag approprié
4. Update ce dashboard avec le nouveau count + statut

## Secrets nécessaires (GitHub Actions)

Tous les secrets sont best-effort : si manquant → `test.skip()` propre.

| Secret | Suites concernées |
|---|---|
| `PLATFORM_ADMIN_API_KEY_STAGING` | **00-gate-onpremise (clé M2M — gate prod)** |
| `E2E_ADMIN_EMAIL_STAGING` + `E2E_ADMIN_PASSWORD_STAGING` | 00-gate-onpremise (cleanup), 12-auth-flow (login success) |
| `E2E_TEST_WORKSPACE_ID_STAGING` | 09-dashboard-ui, 02-tracker-to-dashboard |
| `HUB_HMAC_SECRET_ANALYTICS_STAGING` | 06-hub-contract (rejection) |
| `DEMO_SECRET_ANALYTICS_STAGING` | 11-demo-public (re-seed) |

## Liens utiles

- Ticket scope : `todo/sprint-2026-05-22-mega/TURBO-E2E-ANALYTICS-SCOPE.md`
- Doc E2E : `docs/E2E-TESTING.md`
- Script auto-issues : `scripts/ci/e2e-report-to-issues.mjs`
- Workflows : `.github/workflows/e2e-*.yml`
- Helpers : `tests/e2e/helpers/`

---

*Dashboard mis à jour automatiquement par le sprint TURBO-E2E (2026-05-23).
Update manuel = changer la table "Suite par dossier" + bump le total.*
