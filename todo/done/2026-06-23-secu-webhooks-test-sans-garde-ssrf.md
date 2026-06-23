# `webhooks.test` n'appelle pas le guard SSRF avant le fetch (oracle inline)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

Asymétrie de protection SSRF. Les chemins async (`deliverOne`) et Twenty
appellent `ssrf.assertSafeUrl` avant le `fetch`. MAIS `webhooks.test` appelle
**directement** `worker.sendOne(webhook, delivery)` qui fait le `fetch`
(`webhook-delivery-worker.service.ts:309`) **sans** re-check SSRF.

Pire : `webhooks.test` renvoie le résultat (body, status, latency) **inline** dans
la réponse HTTP (`webhooks.controller.ts:142-149`). Combiné au SSRF du guard sur
littéral (ticket `2026-06-23-secu-ssrf-webhooks-ip-resolue-redirects.md`), c'est
l'oracle de scan interne idéal : retour synchrone et lisible, bien plus pratique
que le worker async (dont les réponses ne sortent que via `deliveries.list`).

## Localisation (fichiers + lignes)

- `api/src/webhooks/webhooks.controller.ts:103-150` — handler `test()`
- `api/src/webhooks/webhook-delivery-worker.service.ts:286-338` — `sendOne()` sans garde SSRF (fetch ligne ~309)

## Correctif proposé

Appeler `ssrf.assertSafeUrl(webhook.url, ...)` en tête de `sendOne()` (centralise
la garde pour TOUS les chemins sortants) — une ligne, referme l'asymétrie. À
défaut, l'ajouter dans le handler `test()` avant `sendOne`.

## Impact si non corrigé

Amplifie le SSRF webhooks en exfiltration directe et lisible inline. À fixer dans
la même passe que le SSRF DNS.
