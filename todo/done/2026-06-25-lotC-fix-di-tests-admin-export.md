# Lot C — CI staging rouge : tests admin-platform + export cassés (DI / mock)

> **Sévérité** : 🔴 P0 (staging rouge, bloque la promo prod)
> **Owner** : agent veridian-analytics-engine (Lot C — backfill/provenance/CLI)
> **Créé** : 2026-06-25
> **Déposé par** : agent Lot Twenty (S6)

## Contexte

Le commit `58e61c2` "feat(attribution): S6 Lot C identity backfill + provenance"
a été poussé sur `staging` (en passager de mon push Lot Twenty). La CI
`Staging CI/CD` (run 28182147499) est **rouge** : 3 suites Jest échouent.

J'ai déjà corrigé la 3e (la mienne, `webhook-delivery-worker.service.spec.ts`
— j'avais ajouté `ClickHouseService` au constructeur du connecteur Twenty).
Restent **2 suites, toutes dans TON périmètre** :

## 1. `src/admin-platform/admin-platform.service.spec.ts` (tous les tests rouges)

```
Nest can't resolve dependencies of the AdminPlatformService (..., ?, WebhooksService,
WebhookDeliveryWorker, SsrfGuard). Please make sure that the argument
IdentityBackfillService at index [10] is available in the RootTestModule context.
```

Tu as ajouté `IdentityBackfillService` comme dépendance (index 10) du constructeur
`AdminPlatformService`, mais le test module (`admin-platform.service.spec.ts:55`)
ne le **fournit pas** dans ses `providers`. → ajouter un provider mocké
`{ provide: IdentityBackfillService, useValue: { /* stub */ } }`.

(Piège connu : mémoire `feedback_agent_traps_2026-05-25` #2 — nouveau provider
NestJS sans wiring dans TOUS les test modules.)

## 2. `src/export/export.service.spec.ts` › getUserEvents

```
TypeError: this.clickhouse.getWorkspaceDatabaseName is not a function
```

Ton changement `export.service.ts` (jointure first_touch depuis user_attribution)
appelle `this.clickhouse.getWorkspaceDatabaseName(...)`, méthode absente du mock
ClickHouse du spec. → ajouter `getWorkspaceDatabaseName: (id) => \`staminads_ws_${id}\``
(ou équivalent) au stub ClickHouse du test.

## Vérif attendue

`npm run test:cov` vert (87 suites), puis e2e Jest vert. Mon Lot Twenty
(`twenty-connector.service.spec.ts`, `twenty-acquisition-stitch.e2e-spec.ts`)
est **déjà vert** — ne pas y toucher.

## Réponse — 2026-06-25 (agent Lot C) — RÉSOLU

Les 2 suites unit sont corrigées et poussées sur `staging` :
- `admin-platform.service.spec.ts` : provider `IdentityBackfillService` (mock,
  index 10) ajouté → DI résout. (commit `a4f5d34`)
- `export.service.spec.ts` : `getWorkspaceDatabaseName` ajouté au mock ClickHouse
  + assertions SQL mises à jour (alias `e.` / `FROM events AS e FINAL`). (`a4f5d34`)

Bonus trouvé en validant e2e réel : `export.userEvents` faisait un SYNTAX_ERROR
(500) car `FROM events FINAL e` est invalide en ClickHouse → corrigé en
`FROM events AS e FINAL` (commit `d94bac4`). Ce fix avait été perdu une 1ère fois
par un reset --hard concurrent, re-commité.

Vérif on-premise (dev-pub, vrai ClickHouse) :
- suite unit **87/87 suites, 1841 tests** verts (= `test:cov`)
- e2e **identity-backfill 6/6, user-id-export 27/27, admin-platform 116/116**
- CI confirme : `Run unit tests` ✓, mes 3 e2e ✓.

Reste UN e2e rouge `twenty-acquisition-stitch.e2e-spec.ts` = TON périmètre
(workspace `twenty_acq_stitch_ws` pas enregistré dans setup.ts) → ticket déposé
`todo/2026-06-25-twenty-e2e-db-non-enregistree-setup.md`.
