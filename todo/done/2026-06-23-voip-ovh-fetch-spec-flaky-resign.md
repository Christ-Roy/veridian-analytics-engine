# VoIP : `ovh-fetch.spec.ts` flaky en CI (re-signature timestamp)

> **Sévérité** : 🟢 P2 (test flaky, bloque la CI Staging par intermittence)
> **Owner** : agent voip (PAS webhooks — signalé en passant)
> **Créé** : 2026-06-23

## Contexte

Repéré pendant la passe sécu webhooks (commits `cae0518` / `19ff0e2`). Le test
`src/voip/providers/ovh-fetch.spec.ts:116` introduit par le commit voip
`83d7d7a` ("fix(voip): timeouts, OVH incremental/re-sign, provision rollback")
est **flaky** :

```
● fetchOvhCdr — periodic re-signature on long pulls
  › re-fetches /auth/time when the signing timestamp goes stale
  expect(received).toBeGreaterThanOrEqual(expected)
  Expected: >= 2
  Received:    1   (parfois 2)
```

Sur le run du commit voip seul (28028018144) il échouait 2×, sur le run suivant
(28028052613) 1× → comportement non déterministe (dépend probablement d'un
timing réel / `Date.now()` au lieu de fake timers pour la fenêtre de
re-signature).

## Demande

L'agent voip rend ce test déterministe (fake timers sur la fenêtre de staleness
du timestamp de signature OVH, ou assertion sur le nombre d'appels `/auth/time`
piloté par l'horloge mockée). Aucun fichier webhooks/sécu n'est en cause — mes
commits ne touchent pas `voip/`. À fixer côté voip pour débloquer la CO Staging
verte.

## Impact

Tant que ce test reste flaky, la CI Staging "Test & Coverage" peut sortir rouge
de façon intermittente et bloquer les promos — y compris pour des commits sans
rapport (comme la passe webhooks).

## Résolution — 2026-06-23 (agent voip)

RÉSOLU. Le test mélangeait `Date.now()` réel et `jest.setSystemTime` (course
horloge réelle/mockée). Réécrit en pilotant **entièrement** l'horloge du signer
via `jest.spyOn(Date, 'now')` avec une séquence fixe ancrée sur un epoch
constant (`base = 1_750_000_000_000`) — zéro dépendance à l'horloge réelle, zéro
fake timer (donc aucune interaction avec les timers `AbortSignal.timeout` du
provider, qui sont unref'd et ne firent jamais car le fake fetch résout
synchroniquement). Le test du cap-after-sort capture `Date.now()` UNE fois et
ancre `since` + `creationDatetime` dessus → comparaison relative déterministe.

Assertion durcie : `expect(authTimeCalls).toBe(2)` (exact, plus de `>=`).

Preuve CI : run Test & Coverage 28028306800 (commit cb3aa80) VERT —
`PASS src/voip/providers/ovh-fetch.spec.ts`, 77 suites / 1657 tests unitaires
passés, E2E 590 passés. Plus de flakiness.
