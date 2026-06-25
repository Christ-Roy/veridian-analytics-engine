# Chasse boîte blanche 2026-06-25 — résidus P2/P3 (dette de nettoyage)

> **Sévérité** : 🟢 P2 / 🔵 P3 (regroupés — aucun ne casse l'argent client)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-25
> **Source** : agent hunt-whitebox (read-only), rapport complet en scratchpad

La chasse a confirmé que le code est **très bien défendu** (query-builder paramétré,
SSRF guard anti-rebinding sur le chemin générique, helmet/CSP/HSTS, throttler par
tier, WorkspaceAuthGuard anti-IDOR, caches bornés sauf 1). Les 2 vrais P1 trouvés
(memory leak `workspaceCacheKeys` + SSRF connecteur Twenty) sont traités dans la
vague HUNT en cours. Ce ticket regroupe les résidus P2/P3 NON traités, à abattre
dans une passe nettoyage ultérieure.

## 1. 🟢 `console.log` résiduel chemin chaud (back + front)
- `api/src/analytics/analytics.service.ts:735` — `console.log` échappé au refactor Logger (commit 5eaa118) → `this.logger.debug(...)`.
- `console/src/routes/_authenticated/workspaces/$workspaceId/explore.tsx:113` — `console.log('[AssistantConfig] Received config:', JSON.stringify(config))` **dump la config workspace dans la console navigateur du client** → supprimer ou gater `import.meta.env.DEV`.

## 2. 🟢 Interpolation SQL directe api-keys (faible risque, incohérence de style)
`api/src/api-keys/api-keys.service.ts:385` et `:428` : `ALTER TABLE api_keys DELETE WHERE id = '${dto.id}'` au lieu des params bindés `{id:String}` utilisés partout ailleurs (L409, L444). Les `id` viennent d'un lookup DB (UUID system-generated) → pas exploitable en l'état, mais défense-en-profondeur + cohérence : passer en paramétré OU `isUUID()` strict avant interpolation aux 3 sites (L228 inclus) + commenter.

## 3. 🟢 `findDue()` sans LIMIT + scheduler N+1 séquentiel
`api/src/subscriptions/subscriptions.service.ts:233-246` : `SELECT * FROM report_subscriptions FINAL WHERE ...` sans LIMIT → charge toutes les subs dues en mémoire. Scheduler boucle `for ... await processSubscription` séquentiel (N+1). Sur backlog post-downtime = chargement non borné + lent. Correctif : `LIMIT {batch:UInt32}` (~200) + batch borné. (Le gate ENV du @Cron est traité par le ticket A3 subscriptions.)

## 4. 🟢 Dette legacy bridge front : lecteur `VITE_VERIDIAN_ADMIN_KEY` dans code mort
`console/src/veridian/api.ts:171` + `console/src/veridian/pages/settings-helpers.ts:34` : `adminKey()` lit `import.meta.env.VITE_VERIDIAN_ADMIN_KEY` (inlinée en clair dans le bundle public au build) et l'envoie en Bearer. Code quasi-mort (les 3 features in-scope utilisent le JWT natif ; `requireAdmin` appelé uniquement depuis `_archive/pages/settings.tsx`). Bombe à retardement : un build avec la var settée leak la clé bridge à tous les navigateurs. Cohérent avec `feedback_skill_analytics_provision_legacy_key` (le bridge legacy doit dégager). Correctif : supprimer `veridian/api.ts`, `settings-helpers.ts`, `_archive/pages/settings.tsx` ; garder seulement `fetchCheckTracker` + `BridgeApiError` (importés par `welcome.tsx`).

## 5. 🟢 Strings anglaises résiduelles dans une app 100% FR
`console/src/components/Assistant/AssistantPanel.tsx` (L54,58,63,68,73,79,82,101,108) + `console/src/components/setup/CodeSnippet.tsx:19` : "Suggested configuration:", "Period:", "View Report", "Dismiss", "Copied to clipboard"... → traduire (vouvoiement, accents).

## 6. 🔵 Deux `setTimeout` front sans cleanup dans useEffect
`console/src/routes/_authenticated/workspaces/$workspaceId.tsx:79-82` (focus 0ms) + `console/src/components/dashboard/DimensionTableWidget.tsx:127` (debounce 300ms). Impact négligeable (ref/focus), mais timer non nettoyé si unmount rapide → `return () => clearTimeout(id)`.

## Axes vérifiés PROPRES (pour mémoire — ne pas re-chasser)
Injection SQL analytics (query/funnel builder whitelistés), IDOR cross-tenant (WorkspaceAuthGuard solide), SSRF hors connecteur Twenty (delivery/tools/verify tous durcis), secrets loggués (aucun), headers sécu (helmet complet), caches bornés (sauf workspaceCacheKeys traité P1), crons (VoIP/GSC gatés), front archi (zéro réactivation feature démantelée, zéro sous-route Veridian interdite), `any` front (non sensibles).
