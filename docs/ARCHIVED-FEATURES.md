# Archived features

> Sprint cleanup-veridian-scope, 2026-05-23.
> Code conservé dans `_archive/` mais **plus chargé au boot** ni exposé en UI.
> Différent des optional-features (qui restent importables, juste débranchées
> de la nav) : ici le code est isolé, pas compilé dans le bundle prod ni
> wiré dans le serveur.

## Push notifications PWA (B2)

### Pourquoi archivé

Scope change Robert 2026-05-23 : les notifications push web ne sont plus dans
l'offre commerciale Analytics. Robert : *"dégage ça mais laisse en archive
à la limite"*.

### Localisation

- **Bridge backend** : `veridian-bridge/_archive/push/` (modules `index.ts`,
  `routes.ts`).
- **Tests intégration** : `veridian-bridge/_archive/tests-integration/push/`
  (cascade, expired-cleanup, send-notification, subscribe, unsubscribe).
- **Console PWA register** : `console/src/veridian/_archive/pwa-register.tsx`.
- **Service worker** : supprimé (`console/public/sw.js` deleted, pas
  d'archive UI nécessaire — sera regénéré au besoin).

### DB

Les tables `PushSubscription` et `PushNotification` **restent en base**.
Robert a dit "archive", pas suppression destructive. Le code Prisma les
référence toujours dans `schema.prisma` (modèles + relations Tenant).

Si confirmation plus tard que le push est définitivement abandonné, créer
une migration `2026XX_drop_push_tables.sql` :

```sql
DROP TABLE IF EXISTS "PushNotification";
DROP TABLE IF EXISTS "PushSubscription";
```

Et retirer les relations `Tenant.pushSubscriptions` / `pushNotifications`
de `schema.prisma`.

### ENV retirées

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

Retirées de `compose/base.yml`, `compose/dev.yml`. Le commentaire référentiel
dans `compose/prod.yml` est conservé pour rappel.

### Comment réactiver

1. Restaurer `veridian-bridge/_archive/push/` → `veridian-bridge/src/push/`.
2. Restaurer `veridian-bridge/_archive/tests-integration/push/` →
   `veridian-bridge/tests/integration/push/`.
3. Restaurer `console/src/veridian/_archive/pwa-register.tsx` →
   `console/src/veridian/pwa-register.tsx` ET re-créer `console/public/sw.js`
   depuis le legacy `veridian-analytics/public/sw.js` (ou le réécrire selon
   les besoins).
4. Re-câbler le `try { registerPushRoutes(...) }` dans `veridian-bridge/src/index.ts`
   (cf. version précédente — git history).
5. Re-définir `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` dans
   les composes.
6. Mettre à jour `veridian-hub/docs/PRICING-VERIDIAN.md` si la feature
   revient en commercialisation.

## Forms / Leads (B1) — SUPPRIMÉ (pas archivé)

Note : le module Forms a été supprimé (drop destructif), pas archivé. Robert :
*"Supprimer le code bridge forms"*.

- Code retiré de `veridian-bridge/src/forms/` (git rm).
- Migration DROP créée : `prisma/migrations/20260523000000_drop_forms_leads/`
  (DROP `FormSubmission`, `FormSchema`, `Lead`, `LeadSession`). `Site` est
  conservée (utilisée par `settings/store.ts` + `provision-existing-tenant`).
- Tests retirés (`tests/forms/`, `tests/integration/forms/`).
- Tab UI archivé dans `console/src/veridian/_optional-features/dashboard-tabs/forms-tab.tsx`
  (le stub esthétique, sans backend).

Le matching VoIP `phone → visitorId` qui passait par `Lead.phone` est
désactivé : `src/voip/match.ts::resolveVisitorIds()` est devenu un no-op.
Les appels sont enregistrés sans `visitorId`. Si on rebranche un matching
téléphone → web, repartir du tracker `tel:` directement.

Migration de rollback : voir
`prisma/migrations/20260522000000_add_forms_leads/migration.sql` pour
recréer le schéma exact (données legacy perdues).
