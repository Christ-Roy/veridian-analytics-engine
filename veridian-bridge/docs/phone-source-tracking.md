# Phone source tracking — 1 numéro = 1 source

> Sprint **feat P0** — 2026-05-25 (vision Robert)
>
> Permet au bridge d'enrichir chaque event `phone_call` poussé vers staminads
> avec la dimension `properties.source` (SEO / Ads / direct / email / social
> / print / other). Les appels apparaissent automatiquement dans Live /
> Explore / Goals staminads natifs, filtrables par dimension `source`. Aucune
> page custom côté UI — la vision UI strict (CLAUDE.md analytics) interdit les
> sous-routes custom dans `console/src/routes/_authenticated/workspaces/...`.

## Le pattern business

Robert affiche un **numéro de téléphone différent par source de trafic** sur
ses supports :

- numéro `+33177...001` sur la home du site → **SEO**
- numéro `+33177...002` sur la landing Google Ads → **Ads**
- numéro `+33177...003` sur un flyer print → **Print**
- etc.

Quand un appel arrive sur un numéro X, le call log remonté du provider VoIP
(OVH Telephony, Telnyx) porte ce numéro en `toNumber`. Le bridge fait alors
un lookup `(tenantId, e164 = toNumber)` dans la table `TenantPhoneNumber`
pour récupérer la `source` mappée, et l'injecte dans le payload `phone_call`.

Côté staminads, Live / Explore / Goals voient un event natif avec la
propriété `source` — filtrable, groupable, comptable comme n'importe quel
custom event. Goals peut être configuré pour ne déclencher que sur
`source = ads` par exemple.

## Schéma DB

Migration `20260525000000_add_tenant_phone_number` :

```prisma
model TenantPhoneNumber {
  id        String            @id @default(cuid())
  tenantId  String
  e164      String            // numéro E.164 normalisé
  source    PhoneNumberSource @default(direct)
  label     String?           // libellé optionnel ("ligne fixe SEO")
  createdAt DateTime          @default(now())
  updatedAt DateTime          @updatedAt

  tenant    Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, e164])
  @@index([tenantId])
}

enum PhoneNumberSource {
  seo
  ads
  direct
  email
  social
  print
  other
}
```

Cascade FK sur suppression du `Tenant`. Unicité `(tenantId, e164)` pour
éviter les doublons (un même numéro ne peut pas avoir 2 sources pour le
même tenant — c'est business : 1 numéro = 1 source).

## Endpoints admin

Tous Bearer `VERIDIAN_ADMIN_API_KEY`. `:wsId` accepte l'id interne tenant OU
le `workspaceId` staminads.

| Verbe  | Route                                                       | Body                              |
|--------|-------------------------------------------------------------|-----------------------------------|
| GET    | `/api/admin/tenant/:wsId/phone-numbers`                     | —                                 |
| POST   | `/api/admin/tenant/:wsId/phone-numbers`                     | `{e164, source, label?}`          |
| PUT    | `/api/admin/tenant/:wsId/phone-numbers/:id`                 | `{source?, label?}` (pas d'e164)  |
| DELETE | `/api/admin/tenant/:wsId/phone-numbers/:id`                 | —                                 |

`POST` retourne **201** avec `{ok, phoneNumber}`. Validation :

- `e164` doit passer `toE164()` (cf `src/voip/phone-numbers.ts`) — sinon **400 invalid_e164**
- `source` doit être dans la whitelist enum — sinon **400 invalid_source**
- duplicate `(tenantId, e164)` → **409 already_exists**

Le `PUT` interdit volontairement de changer l'`e164` (clé business). Pour
changer un numéro : DELETE + POST.

## Helper `toE164(raw)`

Normalisation FR-only V1, sans dépendance externe (libphonenumber = 200kb,
overkill pour 7 sources). Cf `src/voip/phone-numbers.ts` :

| Entrée                  | Sortie         |
|-------------------------|----------------|
| `+33177123456`          | `+33177123456` |
| `0033177123456`         | `+33177123456` |
| `01 77 12 34 56`        | `+33177123456` |
| `0177-123-456` (10 chars) | `+33177123456` |
| `abc`                   | `null`         |

Si on internationalise, swap vers `libphonenumber-js` (lazy import).

## Push staminads enrichi

Dans `src/voip/sync.ts:pushStaminadsEvents`, avant chaque POST `/api/track` :

```ts
const toE164Norm = toE164(call.toNumber);
const tracked = toE164Norm ? trackedNumbers.get(toE164Norm) : undefined;
const source = tracked?.source ?? "direct";
const trackedNumberId = tracked?.id ?? null;

payload.actions[0].properties = {
  ...existingProps,
  source,                              // toujours présent
  ...(trackedNumberId ? { tracked_number_id: trackedNumberId } : {}),
};
```

`source = "direct"` est le **default safe** : un appel sur un numéro non
trackcé n'est jamais perdu, il est juste comptabilisé sans attribution fine.
Le `tracked_number_id` n'est ajouté que quand un mapping existe — permet
de filtrer dans Goals par numéro précis.

Optimisation : un seul `findMany IN (...)` par batch d'appels par tenant
(au lieu de N queries). Cf `lookupTrackedNumbers()`.

## UI Settings → VoIP

Le panel `console/src/veridian/settings-panels/voip-panel.tsx` reçoit une
sous-section **« Numéros trackés »** collapsable sous les providers OVH /
Telnyx. Tableau (Numéro / Source / Libellé / Actions) + bouton « Ajouter un
numéro » qui ouvre une modal (E.164 + select des 7 sources + libellé libre).

L'UI **ne crée pas de nouvelle route** ni de page dédiée — la règle UI
native pure (CLAUDE.md analytics §VISION) interdit tout `routes/.../calls.tsx`
ou `routes/.../phone-numbers.tsx`. Toute extension Veridian passe par les
onglets Settings ou les events staminads custom.

## Tests d'intégration

`tests/integration/voip/phone-numbers.integration.test.ts` couvre :

- CRUD (POST/GET/PUT/DELETE) + validations (E.164, source, doublon, sécu cross-tenant)
- Push staminads : `source` injectée quand mapping existe
- Push staminads : `source = 'direct'` par défaut quand pas de mapping
- Normalisation E.164 : provider qui renvoie `01...` matche un mapping `+33...`
- Cascade FK : delete Tenant → delete TenantPhoneNumber

## À valider en staging

1. Migration appliquée : `\dt` doit montrer `TenantPhoneNumber`, `\dT` doit
   montrer l'enum `PhoneNumberSource`.
2. UI Settings : la sous-section « Numéros trackés » apparaît, le tableau
   liste les numéros, la modal valide bien l'E.164 (essai avec `01 77...`).
3. Push enrichi : déclencher un sync VoIP staging (`POST /api/admin/voip/sync?tenantId=...`)
   après avoir mappé un numéro, vérifier dans staminads que l'event
   `phone_call` porte bien `properties.source = "<valeur>"`.
