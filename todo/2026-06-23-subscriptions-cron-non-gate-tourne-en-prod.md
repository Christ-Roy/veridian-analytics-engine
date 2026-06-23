# subscriptions : cron non gaté tourne en prod + branding Staminads en dur

> **Sévérité** : 🟢 P2 (quick-win safe)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

La feature subscriptions/rapports-email a été arbitrée "gardée" par Robert
(ticket `todo/2026-06-17-arbitrer-subscriptions-rapports-email.md`, tranché
2026-06-18), MAIS les 2 actions décidées sont **toujours en pending** :

1. **Cron NON gaté** : `subscription-scheduler.service.ts:27`
   (`@Cron('0 */15 * * * *')`) tourne toutes les 15 min sans flag. `grep
   SUBSCRIPTIONS_ENABLED` = vide (comparé à VoIP, gaté sur `VOIP_SYNC_ENABLED`).
   Sans abonnement actif il loggue "Found 0 due" ; mais dès qu'un abonnement
   existe sans SMTP réel → `markFailed` + pollution `audit_logs` (`report_failed`).
2. **Branding Staminads en dur** : `report-generator.service.ts:700`
   (`https://www.staminads.com/favicon.svg`) + `smtp.service.ts:230`
   (`SMTP_FROM_NAME` défaut `'Staminads'`).

Ce ticket est l'**action concrète** du ticket d'arbitrage déjà tranché (pas un
doublon de décision — la décision est prise, l'exécution n'est pas faite).

## Localisation (fichiers + lignes)

- `api/src/subscriptions/scheduler/subscription-scheduler.service.ts:27`
- `api/src/subscriptions/report/report-generator.service.ts:700`
- `api/src/smtp/smtp.service.ts:230`

## Correctif proposé

1. Gater le `@Cron` sur `SUBSCRIPTIONS_ENABLED` (1 ENV + 1 `if`, no-op si absent),
   sur le modèle de `VOIP_SYNC_ENABLED`.
2. Remplacer le favicon et le `SMTP_FROM_NAME` par le branding Veridian (ou le
   rendre configurable par workspace).

## Impact si non corrigé

Cron qui tourne pour rien (et qui polluera `audit_logs` en `report_failed` dès
qu'un abonnement réel existe sans SMTP), et fuite de branding Staminads dans les
emails clients Veridian.
