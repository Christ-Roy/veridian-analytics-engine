# Arbitrer les "Subscriptions" (rapports email programmés) — hors scope, cron actif

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : ARBITRER (documenter OU débrancher) + dette branding
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié)

Le module `subscriptions/` est une **feature staminads complète** : un
utilisateur s'abonne à des rapports analytics envoyés par email sur planning
(quotidien / hebdo / mensuel). Elle est **branchée et découvrable** côté UI
(`console/.../account.tsx` + `components/subscriptions/SubscribeDrawer.tsx` +
`routes/unsubscribe.tsx`), avec **scheduler cron actif** — mais elle n'est ni
dans le scope figé, ni documentée, ni rebrandée.

### Ce qui tourne réellement

- **Cron toutes les 15 min** : `@Cron('0 */15 * * * *')`
  (`api/src/subscriptions/scheduler/subscription-scheduler.service.ts:27`),
  cherche les abonnements dus (`findDue`) et les envoie. `ScheduleModule`
  bien chargé (`app.module.ts:69`).
- 8 méthodes client UI (`lib/api.ts:410-461` :
  list/create/update/pause/resume/sendNow/preview + unsubscribe public).
- Audité (`subscriptions.controller.ts:85-333`, 7 call sites `auditService.log`).

### Mais : dormant + dette upstream

- **Dépend de SMTP** : fail-fast `smtpService.getInfo()`
  (`subscription-scheduler.service.ts:68-75`). Or `SMTP_HOST` a un défaut
  **vide** dans `compose/base.yml:65` (`${SMTP_HOST:-}`). Si SMTP non posé en
  prod → chaque run du cron jette + `markFailed` + audit
  `subscription.report_failed`. **Le scheduler tourne mais échoue
  silencieusement** tant que SMTP n'est pas configuré.
- **Branding Staminads en dur** dans le rapport email :
  `report-generator.service.ts:700` (`https://www.staminads.com/favicon.svg`).
  Un client Veridian recevrait un email de rapport brandé Staminads.

## Décision à faire (Robert)

Les rapports email programmés ne sont pas dans les « 3 features visibles
client » figées 2026-05-25, mais ce n'est pas une feature « dénaturante » (pas
de page custom, pas de limite visible) — c'est une commodité staminads native.

- **Option A — Garder + documenter + rebrander** : poser `SMTP_HOST` réel en
  prod (relai Veridian existe, cf skill `postfix`), corriger le branding
  email, l'ajouter à la cartographie modules. Coût faible, valeur réelle pour
  les clients SEO.
- **Option B — Débrancher l'UI** : retirer l'onglet de `account.tsx` + le
  drawer, laisser le backend dormant. Cohérent avec « scope minimal V1 ».

**Reco (~65 %) : Option A** — c'est une feature native qui marche, peu
coûteuse, qui colle au persona SEO (recevoir son rapport hebdo par mail). Le
seul vrai travail = poser SMTP réel (déjà nécessaire pour les invitations et le
magic-link de provisioning) + 1 ligne de branding.

## Impact

État actuel = pire des deux mondes : feature visible côté UI, cron qui tourne
et échoue en boucle (pollue `audit_logs` de `report_failed`), branding
concurrent. À trancher pour sortir de l'ambiguïté.

## Note transverse — SMTP non posé bloque 3 modules

`SMTP_HOST` vide en prod neutralise **invitations** (flow membre),
**subscriptions** (rapports) et le **magic-link** de provisioning M2M
(best-effort mais le client ne reçoit pas son lien). Vérifier les ENV Dokploy
réelles du compose engine (`RH8yiQGFLxTzVXtrvlNmB`) : si `SMTP_HOST` n'y est
pas, c'est un trou opérationnel à corriger indépendamment de l'arbitrage
ci-dessus. Cf `[[feedback_env_wire_compose_same_commit]]`.

## Liens

- Cartographie modules : `2026-06-17-doc-cartographie-modules-backend.md`
