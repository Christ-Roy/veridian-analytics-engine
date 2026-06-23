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

---

## MAJ 2026-06-17 (confirmé encore cassé, sprint GIGA vague C)

Le problème persiste. 3 runs cancelled au timeout 35min confirmés :
- 27692223650 (bafe9d9), 27671748411 (ad14214), 27601058958 (b1c98d2) — tous `cancelled`.

Constats additionnels :
- Le job inclut `03-forms-leads/` et `04-push-pwa/` = features SUPPRIMÉES/archivées
  par la vision 2026-05-23. Ces specs traînent/échouent et gonflent la durée pour rien.
- `|| true` toujours présent sur la step principale (gate ne peut pas échouer).

### Fix proposé (consolidé)
1. Retirer `|| true` (gate doit pouvoir rouge).
2. Sharding Playwright `--shard=i/N` en jobs matrix parallèles (chaque < 35min),
   OU séparer "smoke + modules critiques" (bloquant, rapide) vs "full nightly" (informatif).
3. Retirer les specs de features mortes (03-forms-leads, 04-push-pwa).
4. webkit ciblé (responsive/visual) au lieu de partout.

Contournement utilisé pour la promo de la vague revoke+voip+gsc (2026-06-17) :
CI staging Test&Coverage (E2E API contre ClickHouse RÉEL) + deploy+smoke verts +
smoke manuel des 3 modules. Le gate Playwright UI full n'a PAS pu servir.

---

## ✅ RÉSOLU 2026-06-23 — voir ticket mega-battery

Résolu par le même chantier que
`2026-06-18-mega-battery-e2e-full-staging-perimee-gate-mort.md` (archivé en
done). Le gate de référence n'est plus `e2e-full-staging` (Playwright UI, que le
runner public ne peut pas faire tourner contre le staging tailnet) mais le
nouveau **`e2e-gate-onpremise.yml`** : il SSH dans dev-pub, exécute le scénario
M2M contre staging réel, **peut rouge et bloque** la promo, et tourne RÉELLEMENT
VERT en CI. `e2e-full-staging` devient un nightly informatif best-effort (le
`|| true` reste volontairement — ce n'est plus le gate). Specs mortes purgées.
