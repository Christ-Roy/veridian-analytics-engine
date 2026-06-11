# Durcir le gate `e2e-full-staging.yml` — `|| true` + hang

> **Sévérité** : 🟡 P1 — gate de promo non fiable
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-11

## Problème constaté (promo #23, 2026-06-10/11)

Le workflow `e2e-full-staging.yml`, censé être le gate E2E lourd avant
promotion staging→main (tier 🔴), a deux défauts qui le rendent inutilisable
comme garde-fou bloquant :

1. **`|| true` sur l'étape principale** : la step "Full battery staging (all
   P0+P1 suites)" se termine par `npx playwright test … || true`. Donc même
   si des specs sont ROUGES, l'étape (et le job) conclut `success`. Un gate
   qui ne peut pas échouer ne protège rien — faux sentiment de sécurité.

2. **Hang / durée non bornée** : le run `27313076161` (déclenché 23:29Z) est
   resté >28 min sur la seule step "Full battery" sans verdict. Le run
   précédent du jour (`27275328959`, 12:12Z) avait été cancelled à 35 min.
   Aucun `timeout-minutes` sur le job/step → le runner traîne jusqu'au
   timeout GH par défaut. Probable cause : specs Playwright qui timeout en
   série (retry × N) sans fail-fast.

## Impact

- La règle team-lead "E2E lourd OBLIGATOIRE avant promo main" ne peut pas
  s'appuyer sur ce workflow : il passe toujours vert (`|| true`) et prend un
  temps non borné. L'agent doit valider à la main en ciblé (fait pour #23 :
  webhooks 401, fix G1 export.userEvents 200+properties en réel, migration v7
  lue non-destructive) — ce qui marche mais n'est pas industrialisable.

## Action attendue

1. **Retirer `|| true`** de la step "Full battery" — laisser le exit code
   Playwright remonter. Si certaines suites sont volontairement non-bloquantes
   (flaky connus), les isoler dans une step dédiée explicitement tolérante,
   PAS noyer toute la batterie P0+P1 sous un `|| true`.
2. **`timeout-minutes`** sur le job (ex 25) + `--max-failures=1` ou
   `forbidOnly`/`fail-fast` sur la commande Playwright pour borner la durée et
   couper tôt sur une cascade de timeouts.
3. **Identifier la/les spec(s) qui hang** (probablement une attente réseau sans
   timeout court contre staging) et les fixer ou réduire leur timeout.
4. Une fois fiable, ce workflow redevient le gate de référence et la règle
   "lance le E2E lourd à la main" est levée pour l'engine.

## Lien
- Run hang : https://github.com/Christ-Roy/veridian-analytics-engine/actions/runs/27313076161
- Workflow : `.github/workflows/e2e-full-staging.yml`
