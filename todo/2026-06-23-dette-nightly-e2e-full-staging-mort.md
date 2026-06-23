# 🟢 Dette : le nightly `e2e-full-staging.yml` cancelle 35min/jour en testant des features mortes

> **Sévérité** : 🟢 P2 (le VRAI gate de promo est ailleurs et marche — ceci n'est plus qu'une nuisance CI)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23 (consolide `durcir-e2e-full-staging-gate` + `mega-battery-e2e-full-staging-perimee`)
> **Vérifié contre** : runs CI réels + `origin/staging`, 2026-06-23

## Contexte — ce qui a CHANGÉ (le sujet original est résolu, sauf le nettoyage)

Les deux tickets d'origine demandaient de "durcir le gate E2E lourd bloquant". **C'est FAIT,
mais autrement** : le gate de promo prod est désormais **`e2e-gate-onpremise.yml`** (livré
2026-06-23, commits `db2c3aa`→`c2560bc`), qui tourne RÉELLEMENT via SSH sur dev-pub (staging =
tailnet, injoignable depuis un runner public). Runs vérifiés : **success en 24s–1m2s**. C'est le
rempart réparé. Couvre : provision → snippet → ingestion round-trip ClickHouse → /api/track →
analytics.query → VoIP → gsc.status.

→ Les tickets `durcir-e2e-full-staging-gate` (2026-06-11) et `mega-battery-...` (2026-06-18) sont
**archivés/résolus sur `origin/staging`** (tous deux dans `todo/done/`).

## Le reste-à-faire RÉEL (vérifié 2026-06-23)

Le **vieux** workflow `e2e-full-staging.yml` (Playwright UI full, nightly 02:00 UTC + dispatch)
n'est plus le gate bloquant, MAIS il **cancelle au timeout 35min TOUS LES JOURS** sur le schedule
(runs `28005735678`, `27936014419`, `27896329182`… tous `cancelled`). Il :
- garde `|| true` sur la step principale (ne peut pas conclure rouge) ;
- inclut/teste des features **MORTES** : `03-forms-leads/`, `04-push-pwa/` (supprimées par la
  vision 2026-05-23), specs `score-value`/`shadow-marketing-grid`, deep-links `/veridian`,`/leads`
  (routes custom supprimées). Specs route /veridian déjà purgées côté `tests/e2e/` (commit `c2560bc`).

C'est du bruit CI quotidien : un run rouge/cancel récurrent qui ne surveille rien.

## Demande (chantier de ménage, pas urgent)
**Trancher entre 2 options** (reco A) :
- **A (reco ~70%)** : **supprimer purement `e2e-full-staging.yml`**. Le gate on-premise + la CI
  Staging (Jest E2E vs ClickHouse réel) couvrent le besoin réel. Un nightly Playwright UI full
  qui cancelle ne sert à rien. Le plus propre.
- **B** : le réduire à un smoke UI court (chromium only, `timeout-minutes: 10`, retirer `|| true`,
  retirer les specs de features mortes, sharding si besoin) — SEULEMENT si on veut une surveillance
  visuelle nightly. Plus de travail pour une valeur faible vu que le on-premise existe déjà.

## Note
Cf mémoire `feedback_gate_e2e_full_staging_perime` (le gate périmé = inopérant ; le vrai rempart
= Staging CI/CD + gate on-premise). Ce ticket consolide définitivement le sujet.
