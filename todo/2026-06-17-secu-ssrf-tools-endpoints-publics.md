# 🔴 SSRF non protégé : tools.websiteMeta + tools.favicon (publics, non-auth)

> **Sévérité** : 🔴 P0 (sécurité — remontée hors-axe doc, devoir de signalement)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : CÂBLER (fix sécu) — ou débrancher si hors-usage
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié de visu)

Deux endpoints **publics et non authentifiés** du module `tools/` font un
`fetch` d'URL **entièrement contrôlée par l'appelant**, **sans aucune
protection SSRF** — alors que le repo contient DÉJÀ une garde SSRF complète et
l'applique systématiquement côté webhooks. Asymétrie de sécurité flagrante.

### Les endpoints

- `POST /api/tools.websiteMeta` — `@Public()` (`tools.controller.ts:22-23`).
- `GET /api/tools.favicon?url=...` — `@Public()` (`tools.controller.ts:42-43`).

Aucune authentification : exploitables depuis Internet par n'importe qui.

### Le trou

`getWebsiteMeta(dto.url)` (`tools.service.ts:28-34`) :

```ts
async getWebsiteMeta(url: string): Promise<WebsiteMetaResponse> {
  const response = await fetch(url, { headers: { 'User-Agent': '...' } });
  ...
}
```

→ `fetch` direct sur l'URL postée. **Aucune validation** (pas même le
protocole). Un attaquant peut POSTer :
- `http://169.254.169.254/latest/meta-data/...` → **métadonnées cloud**
  (credentials IAM selon l'hébergeur)
- `http://127.0.0.1:8123` → **ClickHouse interne**
- `http://10.x` / `http://192.168.x` → **scan réseau privé**

Pire : `findLogo` / `findManifestIcon` suivent les `href`/manifest extraits de
la réponse (fetch en cascade), et `fetchImage` fait `redirect: 'follow'`
(`tools.service.ts:299`) → un endpoint public qui **redirige** vers
`169.254.169.254` est suivi.

`getFavicon(url)` ne valide que le **schéma** (`validateUrl` accepte http/https)
— rien sur l'hôte. `isPrivateHostname` n'est jamais appelé.

### La garde existe déjà et n'est PAS utilisée ici

`api/src/webhooks/webhook-ssrf-guard.ts` (`assertSafeUrl`) couvre loopback,
RFC1918, 169.254 (métadonnées cloud), IPv6 ULA/link-local, anti-loop engine.
Elle est appelée sur **chaque** fetch sortant côté webhooks
(`webhooks.service.ts:91,182`, `webhook-delivery-worker.service.ts:146,269`).

Le module `tools/` **ne l'importe ni ne l'utilise** (grep : zéro occurrence
hors `webhooks/`). On a donc une garde SSRF maison appliquée aux webhooks
authentifiés… mais pas aux deux endpoints publics non-auth qui font exactement
le même fetch d'URL arbitraire.

## Demande précise (voie propre)

1. Injecter `WebhookSsrfGuard` (ou en extraire un `SsrfGuard` partagé dans
   `common/`) dans `ToolsService`.
2. Appeler `assertSafeUrl()` **avant chaque** `fetch` : `getWebsiteMeta`,
   `fetchImage`, `extractFaviconUrl`, `findManifestIcon` — y compris sur les
   URLs résolues en cascade (manifest, href de logo).
3. Conserver `redirect: 'follow'` UNIQUEMENT si on re-valide chaque hop (sinon
   passer en `redirect: 'manual'` + re-check). La garde actuelle webhook valide
   le literal, pas l'IP résolue (limite DNS-rebinding connue,
   `webhook-ssrf-guard.ts:14-18`) — au minimum atteindre la même barre que les
   webhooks.
4. Gater http (vs https-only) par ENV si besoin de fetch de sites client en
   http.

**Alternative si hors-usage** : `tools.websiteMeta` sert à la détection de logo
au provisioning/onboarding (`settings.tsx:212`, `workspaces/new.tsx:61`) et
`tools.favicon` est utilisé en `<img src>` dans les dashboards
(`DashboardGrid.tsx:465`). Ils SONT utilisés → ne pas débrancher, sécuriser.

## Impact

SSRF non authentifié exploitable depuis Internet = (1) exfiltration potentielle
de credentials cloud via métadonnées `169.254.169.254`, (2) scan/atteinte de
services internes (ClickHouse, réseau privé Dokploy). Classé OWASP A10:2021
(SSRF). Le fait que la garde existe déjà rend le fix peu coûteux et l'omission
d'autant plus anormale.

## Vérifs avant promo

- `curl -X POST .../api/tools.websiteMeta -d '{"url":"http://169.254.169.254/"}'`
  → doit être REJETÉ (400/403), pas fetché.
- Idem `http://127.0.0.1`, `http://10.0.0.1`, et une URL qui redirige vers
  `169.254.169.254`.
- Non-régression : un vrai site client HTTPS retourne toujours title + logo.
