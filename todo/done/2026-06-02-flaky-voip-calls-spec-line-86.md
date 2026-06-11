# Test flaky `demo/fixtures/voip-calls.spec.ts:86`

> **Sévérité** : 🟡 P1 — bloque la CI staging à chaque push
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-02
> **Découvert par** : agent SDK-publish (working on tunnel de vente étape 2)

## Symptôme

Job `Test & Coverage` (workflow `dev-checks.yml`) échoue avec :

```
FAIL src/demo/fixtures/voip-calls.spec.ts
  ● ... (line 86 - eventDate.getTime() ≤ baseConfig.endDate.getTime())

  expect(eventDate.getTime()).toBeLessThanOrEqual(baseConfig.endDate.getTime())
```

Tests Suites: 1 failed, 45 passed, 46 total
Tests:       1 failed, 1184 passed, 1185 total

## Reproduction

Survient SYSTÉMATIQUEMENT sur les push staging au moins depuis le SHA
`55f4642` (2026-06-02 14:43Z) et `51cbe32` (2026-06-02 14:46Z).

Local reproductible avec `npm test` dans `api/`.

## Diagnostic rapide

Lignes 84-89 de `voip-calls.spec.ts` :

```ts
const eventDate = new Date(ev.received_at.replace(' ', 'T') + 'Z');
expect(eventDate.getTime()).toBeGreaterThanOrEqual(start.getTime());
expect(eventDate.getTime()).toBeLessThanOrEqual(
  baseConfig.endDate.getTime(),
);
```

Le test compare un timestamp d'event seedé contre une borne haute
`baseConfig.endDate`. Hypothèse : le générateur dépasse la borne haute
de quelques ms (clock skew ou off-by-one dans la fenêtre temporelle
du seed VoIP).

Probable origine : commits récents sur le seed VoIP demo
(`chore(demo): rename sessions to visites uniques` ou similaire qui a
touché les fixtures temporelles).

## Impact

- CI staging **rouge** à chaque push, même quand le code shippé est
  parfaitement OK. Les agents perdent du temps à vérifier que ce
  n'est PAS leur fix qui a cassé.
- Bloque la promotion staging → main via le workflow `Staging CI/CD`
  (cf §20 promotion graduée par risque dans CI-ARCHITECTURE.md).
- Agent SDK-publish (2026-06-02) : a poussé `feat/sdk-publish-staging`
  ce qui a déclenché la même fail → CI rouge non liée au SDK.

## Action attendue

1. Reproduire localement : `cd api && npm test -- voip-calls.spec.ts`
2. Inspecter la borne haute `baseConfig.endDate` vs la fenêtre du
   générateur dans `api/src/demo/fixtures/voip-calls.ts`
3. Soit corriger le générateur (clamp), soit relaxer la borne du test
   (tolerance de quelques secondes — c'est du seed, pas du code prod).
4. Ne PAS `.skip()` le test — la couverture VoIP demo doit rester
   exercée. Préférer un fix de la borne.

## Lien

- Run CI failing : https://github.com/Christ-Roy/veridian-analytics-engine/actions/runs/26827550899
- Spec : `api/src/demo/fixtures/voip-calls.spec.ts:86`
- Generator : `api/src/demo/fixtures/voip-calls.ts`
