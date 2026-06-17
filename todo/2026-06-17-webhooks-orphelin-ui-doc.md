# Webhooks — module backend complet, 0 surface UI, doc utilisateur absente

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : DÉCIDER (API-only documenté OU exposer UI) — clarifier l'intention
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié)

Le module `webhooks/` est le **plus gros module backend non découvrable** : un
arsenal complet de webhooks sortants, et **zéro surface côté console**.

### Ce qui existe (backend, `api/src/webhooks/`)

- **9 routes HTTP** (`webhooks.controller.ts:46-215`) : create / list / get /
  update / delete / test / deliveries.list / deliveries.retry / events.
- `webhook-ssrf-guard.ts` (loopback, RFC1918, 169.254, IPv6 ULA, anti-loop
  engine).
- `webhook-filter-engine.ts`, `webhook-transform-engine.ts`,
  `webhook-delivery-worker.service.ts`, `webhook-dispatcher.service.ts`,
  `connectors/` (dont le connecteur Twenty natif).
- Émet `event.tracked` avec `goal_name` + `properties`
  (cf `docs/EVENTS-CUSTOM.md:70`).

### Ce qui manque

- **0 client dans `console/src/lib/api.ts`**, **0 page/onglet** « Webhooks » ou
  « Destinations » dans Settings. Un utilisateur ne peut PAS créer/voir un
  webhook via l'UI.
- **0 doc utilisateur/intégrateur** : seul `todo/PATTERNS-WEBHOOKS.md` (notes
  internes de dev) existe. Rien dans `docs/`, rien dans le CLAUDE.md.

## Question à trancher

Est-ce **volontairement API-only / cross-app** (le connecteur Twenty natif
pousse via ce module en interne, cf memory
`[[project_twenty_connector_native_proven]]`) — OU une feature destinée aux
clients mais jamais finie côté UI ?

- Si **API-only assumé** : c'est légitime (pas tout n'a besoin d'UI). →
  **DOCUMENTER** : 1 entrée dans la cartographie modules + 1 note dans
  `docs/` précisant « webhooks = surface API/cross-app, pas de config UI en V1,
  piloté par le connecteur natif ». Promouvoir `todo/PATTERNS-WEBHOOKS.md` en
  `docs/WEBHOOKS.md` si pertinent.
- Si **feature client prévue** : c'est un chantier UI à scoper (onglet Settings
  « Destinations »), mais ⚠️ **hors des 3 features figées** → arbitrage Robert
  d'abord (ne PAS créer de page dédiée, onglet Settings max).

**Reco (~75 %)** : API-only assumé (le connecteur Twenty est le vrai
consommateur). → documenter comme tel, ne PAS construire d'UI. La règle scope
2026-05-25 ne mentionne pas les webhooks comme feature client.

## Impact

Module lourd (SSRF guard, 3 engines, delivery worker, connectors) sans aucune
trace de son rôle dans la doc « officielle ». Un agent qui découvre ce module
ne sait pas s'il doit lui construire une UI (perte de temps) ou le laisser
API-only. Clarifier l'intention évite le sur-investissement ET la suppression
accidentelle d'un module qui porte le connecteur Twenty (= réconciliateur
identité, critique).

## Liens

- Cartographie modules : `2026-06-17-doc-cartographie-modules-backend.md`
- Notes dev existantes : `todo/PATTERNS-WEBHOOKS.md`
