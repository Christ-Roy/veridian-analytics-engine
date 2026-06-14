# SDK tracker.js bloqué sur staging depuis un navigateur réel (Private Network Access)

> **Sévérité** : 🟢 P2 (non bloquant — le gate E2E tunnel poste à l'API directement, pas via navigateur)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-11
> **Demandé par** : agent veridian-site (chantier capture interactions tunnel) + lead tunnel (décision option 2)

## Contexte

Le SDK `GET /sdk/v1/tracker.js` (servi par `api/src/sdk/sdk.controller.ts`) est
**injecté mais BLOQUÉ par Chrome sur staging** dès qu'on charge une page du site
depuis un vrai navigateur. Symptôme côté site :
`<script id="veridian-tracker-sdk">` présent dans le `<head>`,
`window.StaminadsConfig` posé, mais `window.Staminads` reste `undefined`.

Console Chrome :
```
Access to script at 'https://analytics-engine.staging.veridian.site/sdk/v1/tracker.js'
from origin 'https://staging.veridian-h12.pages.dev' has been blocked by CORS policy:
Permission was denied for this request to access the `local` address space.
net::ERR_FAILED
```

## Cause racine = Private Network Access (PNA) de Chrome

Ce n'est PAS un bug CORS classique : les headers actuels sont corrects
(`Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`,
`Content-Type: application/javascript`). Le blocage vient du **PNA** :

- Engine **staging** `analytics-engine.staging.veridian.site` → `100.92.215.42`
  = **IP Tailscale (CGNAT 100.64.0.0/10) = adresse privée**.
- Un site **public** (CF Pages `188.114.x`) qui charge un script depuis une
  **IP privée** déclenche le PNA → Chrome bloque la requête.
- Engine **prod** `analytics-engine.app.veridian.site` → `51.210.7.44` = IP
  publique OVH → **pas de PNA, le SDK marche** (transport validé en prod).

→ Le staging est **tailnet-only par design** (décision lead : on NE l'expose PAS
en public). Donc le seul levier pour débloquer le navigateur-réel sur staging =
le header PNA côté engine.

## Demande précise

Sur les routes du `sdk.controller.ts` qui servent `tracker.js` (et idéalement
le endpoint d'ingestion `/api/track` appelé par le SDK), ajouter le header
**Private Network Access** et gérer le **preflight** :

1. Réponse normale : ajouter le header
   `Access-Control-Allow-Private-Network: true`
   (à côté des `Access-Control-Allow-Origin: *` déjà posés via `@Header`).
2. Preflight `OPTIONS` : quand la requête preflight porte
   `Access-Control-Request-Private-Network: true`, répondre 200/204 avec
   `Access-Control-Allow-Private-Network: true` +
   `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Methods`/`-Headers`
   adéquats. (NestJS : soit `@Header` sur un handler `@Options`, soit dans la
   config CORS globale / un interceptor.)

Réf navigateur : la spec PNA exige ce header explicite pour autoriser
public→private. `*` sur ACAO ne suffit pas pour le PNA.

## Impact côté site (qui dépend de ça)

- **NON bloquant** pour le gate E2E tunnel : le G6 du run CI poste directement
  à l'API engine (pas via navigateur), donc le transport est déjà couvert.
- Ce qui reste impossible tant que ce n'est pas fait : valider à la main, dans
  un vrai navigateur sur staging, que les goals du site (`audit_view`,
  `identify(slug)`, `consent_granted/denied`, `app_started`, …) atterrissent
  bien dans ClickHouse staging. Affecte TOUT le tracker staging, pas un event
  précis. Sur prod ça marche déjà (IP publique).

## Validation attendue

Après patch + deploy staging : depuis un navigateur (ou puppeteer headless avec
résolution de l'IP tailnet), charger une page du site staging → vérifier que
`window.Staminads` se pose et qu'un event apparaît dans
`staminads_ws_vrd_veridian_site_staging.goals` (ClickHouse staging).

## Pièges connus (réf agent site)

- Header `cross-origin-resource-policy: cross-origin` déjà présent et correct —
  ne pas confondre avec le PNA, c'est une autre couche.
- Le message Chrome dit "blocked by CORS policy" mais c'est trompeur : la mention
  "`local` address space" = signature PNA, pas un vrai problème ACAO.
