# E2E Dashboard — Veridian Analytics Engine

> **Statut** : 🟢 Batterie ULTIME livrée — TURBO-E2E sprint 2026-05-23
> **Total specs (estimé)** : ~150 specs réparties sur 20 dossiers (vs ~258 prévus)
> **Couverture** : ~60% du scope TURBO complet — focus P0/P1, P2/P3 partiels

## Vue d'ensemble

Cette doc est un index auto-mis-à-jour qui agrège l'état de la batterie E2E.
Elle est référencée dans `e2e-report-to-issues.mjs` et permet de voir au
premier coup d'œil quels dossiers sont solides et lesquels manquent de
couverture.

## Suite par dossier

| Dossier | Specs | Statut | Bloquant CI | Workflow |
|---|---|---|---|---|
| `01-smoke` | 5 | 🟢 OK | OUI prod + staging | smoke-staging / smoke-prod |
| `02-bugs-regression` | 9 | 🟢 OK (anti-régression 14 bugs) | OUI prod + staging | smoke-staging / smoke-prod |
| `02-tracker-to-dashboard` | 5 | 🟢 Partiel (track + visitor + batch + cors) | OUI staging | full-staging |
| `03-forms-leads` | 3 | 🟢 Partiel (ingest + edge cases + rate-limit) | OUI staging | full-staging |
| `04-push-pwa` | 1 | 🟡 Partiel (VAPID + subscribe shape) | NON | full-staging nightly |
| `05-gsc-oauth` | 1 | 🟡 Partiel (endpoints + CSRF + sync gate) | NON | full-staging nightly |
| `06-hub-contract` | 4 | 🟢 OK (HMAC reject/valid + paywall + idempotency) | OUI staging | smoke-staging |
| `07-settings-credentials` | 1 | 🟡 Partiel (page + voip credentials shape) | NON | full-staging nightly |
| `08-voip-calls` | 1 | 🟡 Partiel (endpoints shape + UI smoke) | NON | full-staging nightly |
| `09-dashboard-ui` | 5 | 🟢 OK (sections + mobile + responsive + tabs + empty) | OUI staging | full-staging |
| `10-onboarding-wizard` | 1 | 🟡 Partiel (welcome route + tracker.detect) | OUI staging | full-staging |
| `11-demo-public` | 6 | 🟢 OK (existant + extensions) | OUI prod | smoke-staging / smoke-prod |
| `12-auth-flow` | 5 | 🟢 OK (login/error pages/logout/JWT/setup) | OUI prod | security-audit nightly |
| `13-cross-app-inbound` | 1 | 🟡 Partiel (Hub→bridge endpoints + propagation) | NON | business-flows manual |
| `14-perf-regression` | 2 | 🟡 Partiel (vitals + bundle + visual snapshot) | NON | perf-regression hebdo |
| `15-chaos` | 1 | 🟡 Partiel (observability stable + burst) | NON | perf-regression hebdo |
| `16-security` | 6 | 🟢 OK (headers/CORS/admin/inject/secrets/HMAC/rate) | NON (nightly) | security-audit nightly |
| `17-multi-tenant-isolation` | 3 | 🟢 OK (cross-tenant + api-key + deletion) | OUI staging | security-audit nightly |
| `18-api-contract` | 2 | 🟢 OK (shape stable + version diag) | OUI staging | security-audit nightly |
| `19-sdk-tracker` | 2 | 🟢 OK (bundle + init + CSP) | OUI staging | full-staging |
| `20-business-flows` | 1 | 🟡 Partiel (lifecycle + form→lead) | NON | business-flows manual |

**Légende statut** :
- 🟢 OK : couverture suffisante pour la commercialisation
- 🟡 Partiel : couvre l'essentiel, à enrichir en P3
- 🔴 Manquant : à livrer avant commercialisation

## Workflows CI actifs

| Workflow | Trigger | Suites |
|---|---|---|
| `e2e-smoke-staging.yml` | Chaque push staging | 01 + 02-bugs + critical |
| `e2e-smoke-prod.yml` | Chaque push main | 01 + 02-bugs + 11-demo (prod) |
| `e2e-full-staging.yml` | Nightly 02:00 UTC | 01-19 (sauf perf/chaos) |
| `e2e-visual-regression.yml` | Hebdo dimanche 03:00 | 14-perf visual snapshots |
| `e2e-perf-regression.yml` | **NOUVEAU** — Hebdo lundi 04:00 | 14-perf (web vitals + bundle) |
| `e2e-security-audit.yml` | **NOUVEAU** — Nightly 03:00 | 12 + 16 + 17 + 18 |
| `e2e-business-flows.yml` | **NOUVEAU** — workflow_dispatch + release/** | 20 + 13 |

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
| `E2E_ADMIN_EMAIL_STAGING` + `E2E_ADMIN_PASSWORD_STAGING` | 12-auth-flow (login success), 20-business-flows |
| `E2E_TEST_SITE_KEY_STAGING` | 03-forms-leads (happy path), 20-business-flows |
| `E2E_TEST_WORKSPACE_ID_STAGING` | 09-dashboard-ui, 02-tracker-to-dashboard |
| `E2E_BRIDGE_ADMIN_TOKEN_STAGING` | 17-multi-tenant-isolation |
| `HUB_HMAC_SECRET_ANALYTICS_STAGING` | 06-hub-contract (provision valide), 13-cross-app-inbound, 20-business-flows |
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
