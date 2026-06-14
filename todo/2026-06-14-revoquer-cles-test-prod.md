# Révoquer les clés API workspace de test générées sur prod le 2026-06-14

> **Sévérité** : 🟢 P2 — hygiène sécu, pas urgent
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-14

## Contexte

Pendant les tests E2E prod du connecteur Twenty (2026-06-14), plusieurs clés API
workspace ont été provisionnées sur `vrd_veridian_site_prod` via l'endpoint M2M
(`provisionApiKey`, names : e2e-prod-test-twenty, recheck-*, isol-test-*,
cleanup*). Elles sont valides et scoped sur le workspace site prod.

## À faire

- Lister les clés workspace de `vrd_veridian_site_prod` (créées 2026-06-14, names
  e2e-*/recheck-*/isol-*/cleanup*).
- Les révoquer (garder uniquement celles légitimement utilisées par le bridge/Hub).
- Vérifier qu'aucune n'est utilisée par un service avant révocation.

## Note

Pas de fuite (clés jamais loggées, redaction OK vérifiée). Simple propreté :
ne pas laisser traîner des clés de test actives en prod.
