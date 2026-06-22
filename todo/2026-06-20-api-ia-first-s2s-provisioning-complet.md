# 🔴 API IA-first : surface admin M2M complète pour brancher/administrer un client en S2S de bout en bout

> **Sévérité** : 🔴 P1 (vision produit IA-first — Robert 2026-06-20)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-20
> **Demandeur** : Robert — *« je veux être sûr que mon app expose des API sécurisées
> qui permettent à une IA de complètement provisionner et administrer facilement le
> tunnel de vente, le tracking du site, le suivi de conversion Google Ads (si lié),
> et en server-to-server facilement »*

## Cap produit (Robert)

L'app doit être **IA-first / API-first** : tout doit être pilotable via des API
sécurisées en S2S, pour qu'une IA (et plus tard une couche MCP) puisse provisionner
et administrer un client de A à Z sans UI. Cf cap noté dans
`todo/2026-06-17-arbitrer-assistant-ia-hors-scope.md` (décision Robert 2026-06-18).

## ✅ BUG IMMÉDIAT — CORRIGÉ 2026-06-21 (commit ffce3db, en prod)

> Le snippet pointe désormais sur /sdk/v1/tracker.js. Vérifié prod : content-type application/javascript. Le reste du ticket (lots S2S + Google Ads) reste à faire.

## 🐛 (historique) BUG IMMÉDIAT — corrigé

`buildTrackerSnippet` (`api/src/admin-platform/admin-platform.service.ts`) génère
un snippet pointant sur **`/tracker.js`** → MAIS cette route renvoie le **HTML du
SPA console** (fallback), PAS le bundle tracker. Le vrai tracker UMD est sur
**`/sdk/v1/tracker.js`** (vérifié prod 2026-06-20 : `/tracker.js` = `<!doctype html>`,
`/sdk/v1/tracker.js` = `!function(){...Staminads...}`). → Un client qui colle le
snippet renvoyé par l'API ne tracke RIEN.
**Fix** : `buildTrackerSnippet` doit émettre `${trackerOrigin}/sdk/v1/tracker.js`.
Ajouter un test contractuel + idéalement un smoke E2E qui vérifie que l'URL du
snippet renvoie bien du `application/javascript` (et non du HTML).

## 📊 État de la surface API (audit 2026-06-20)

L'engine a **24 contrôleurs** mais l'admin **M2M** (`/api/admin/platform/*`, Bearer
`PLATFORM_ADMIN_API_KEY`) n'expose que **5 endpoints** :
`tenants.provision`, `workspaces.{provisionApiKey,revokeApiKey,listApiKeys}`,
`analytics.query`. Tout le reste (gsc, voip, webhooks/Twenty, members, invitations,
filters, dimensions, settings workspace…) est **workspace-scoped** (auth user ou clé
workspace) → **PAS pilotable en S2S par une IA avec la clé plateforme**.

### Gaps identifiés (à transformer en sous-tickets)

1. **Pas de `status`/lecture d'état M2M** : le legacy avait `GET /tenants/:id/status`
   (services actifs, compteurs 28j, snippet, next steps). Aujourd'hui pour savoir
   "où en est ce client" en S2S il faut composer des `analytics.query` à la main.
   → Ajouter un `POST /api/admin/platform/workspaces.status` qui renvoie l'état
   consolidé (tracking actif ? GSC connecté ? VoIP ? compteurs ? snippet correct ?).
2. **GSC en S2S** : la connexion GSC est OAuth dans la console (Settings). Une IA ne
   peut pas la brancher en S2S. → exposer un chemin M2M (au moins lire l'état GSC +
   déclencher une sync ; l'OAuth lui-même reste un consentement humain mais le
   rattachement d'une propriété déjà autorisée pourrait être M2M).
3. **VoIP en S2S** : `phoneNumbers[]` est passable à la provision ✅, mais ajouter/
   retirer un numéro après coup, lister, déclencher une sync = workspace-scoped.
   → équivalents M2M.
4. **Connecteur Twenty / webhooks en S2S** : `webhooks.*` est workspace-scoped.
   Pour brancher le tunnel analytics→CRM d'un client sans UI → équivalent M2M.
5. **Settings workspace en S2S** : timezone, currency, dimensions custom, filtres —
   modifiables seulement via la console. → un `workspaces.updateSettings` M2M.
6. **🔴 Google Ads — TOTALEMENT ABSENT** : aucun module (`grep google.?ads|gclid|
   conversion.?action|roas|offline.?conversion` = 0). Le « suivi de conversion
   Google Ads » demandé par Robert n'existe pas. Chantier dédié à cadrer :
   - capture `gclid` à l'arrivée (le SDK le capte-t-il déjà dans l'event ? à vérifier)
   - liaison campagne → appel/lead (via phone_source='ads' + gclid)
   - **upload d'offline conversions** vers la Google Ads API (S2S, cron) quand un
     lead/appel attribué 'ads' se transforme → ROAS réel
   - NB : un skill `google-ads` existe déjà côté plateforme (IaC YAML + SDK) —
     vérifier la complémentarité (le skill gère le COMPTE Ads ; l'engine devrait
     remonter les CONVERSIONS depuis l'analytics).

## 🔒 Sécurité (le « sécurisé » de la demande)

Auditer/garantir sur toute nouvelle surface M2M :
- Auth Bearer timing-safe (déjà fait sur `PlatformAdminGuard` ✅) + scoping strict
  par `workspace_id` (une clé plateforme ne doit pas fuiter de données cross-workspace
  involontairement, mais ici c'est M2M admin assumé).
- Rate-limiting (throttler global présent), validation stricte des DTO (class-validator).
- SSRF sur les tools (déjà durci, cf `dbb7e65`) — re-vérifier pour tout nouvel
  endpoint qui prend une URL (webhooks, GSC).
- Secrets jamais renvoyés (api_key une seule fois ✅, secret webhook write-only ✅).
- Isolation : un endpoint M2M `status`/`query` doit exiger `workspace_id` explicite,
  jamais d'énumération globale non paginée.

## Demande précise (découpage)

1. **Quick-win** : fix `buildTrackerSnippet` → `/sdk/v1/tracker.js` + test. (P1, < 30 min)
2. **Lot S2S admin** : `workspaces.status`, `workspaces.updateSettings`,
   équivalents M2M pour VoIP/GSC/webhooks (1 endpoint admin par capacité workspace
   utile au provisioning). Spec contractuelle + DTO + tests + doc OpenAPI.
3. **Lot Google Ads** (chantier séparé, à cadrer avec Robert avant code) : capture
   gclid → attribution ads → upload offline conversions → ROAS. Coordonner avec le
   skill plateforme `google-ads`.
4. Mettre à jour le skill `analytics-provision` (déjà recâblé M2M le 2026-06-20) au
   fur et à mesure que les endpoints arrivent.

## Note de branchement immédiat (fait 2026-06-20)

`veridian.site` = workspace **`vrd_veridian_site_prod`** (existe déjà). Clé S2S
active régénérée (`stam_live_b8e0e3c…`, role admin, name `s2s-veridian-site-2026-06`)
— les 7 précédentes étaient toutes `revoked`. Snippet CORRECT à coller dans le
`<head>` de veridian.site :
```html
<script async src="https://analytics-engine.app.veridian.site/sdk/v1/tracker.js"
        data-workspace-id="vrd_veridian_site_prod"></script>
```

---

## ✅ VAGUE 1 LIVRÉE — 2026-06-22 (staging, commit c4ae45b)

22 endpoints M2M `/api/admin/platform/*` (Bearer PLATFORM_ADMIN_API_KEY) :
- **workspaces.status** — état consolidé (tracking/gsc/voip/webhooks/settings + snippet)
- **VoIP M2M** : listPhoneNumbers, addPhoneNumber, removePhoneNumber, listCredentials,
  saveCredential, testCredential, deleteCredential, sync
  (saveCredential write-only GARDÉ — décision Robert 2026-06-22, full-S2S)
- **GSC M2M** : gsc.status, gsc.resync (OAuth reste humain)
- **Webhooks/Twenty M2M** : webhooks.list/create/delete/test (branche le tunnel CRM en S2S)
- **workspaces.updateSettings** (timezone/currency/dimensions/filters)
- **ads.conversions** (lecture des conversions attribuées Google Ads via utm_id_from
  ∈ gclid/gbraid/wbraid OU phone_source='ads' — pour upload par le skill google-ads)

Sécurité : secrets jamais renvoyés (vues Public*), workspace_id requis, SSRF délégué
au WebhooksService, slug validé. Test E2E auth-gate sur les 17 nouveaux endpoints.
Pattern : délégation aux services workspace (zéro duplication).

### Reste à faire (vagues ultérieures)
- **F2 Google Ads — upload offline conversions** (vrai chantier, arbitrages : mapping
  workspace→customer_id, OAuth multi-compte, où vit le pipeline). Reco : skill google-ads
  lit l'engine via ads.conversions puis upload via Google Ads API.
- **SSO autologin Hub** : ticket séparé `2026-06-22-sso-autologin-hub-issue-token.md`
  (+ miroir Hub `2026-06-22-brancher-analytics-au-broker-sso-autologin.md`).
