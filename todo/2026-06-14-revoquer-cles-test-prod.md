# Endpoint M2M revokeApiKey + révoquer les clés de test prod 2026-06-14

> **Sévérité** : 🟡 P1 — TROU SÉCU : les clés workspace M2M ne sont PAS révocables
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-14 (requalifié P1 après diagnostic)

## Trou de conception découvert (2026-06-14)

`admin-platform` expose `POST /api/admin/platform/workspaces.provisionApiKey`
(PlatformAdminGuard M2M) pour CRÉER une clé workspace — mais **aucun endpoint
M2M pour la RÉVOQUER**. Le seul revoke existant, `apiKeys.revoke`, est
`@JwtOnly()` → exige un login utilisateur. Or les workspaces platform-managed
(ex `vrd_veridian_site_prod`) n'ont AUCUN membre → pas de JWT possible.

**Conséquence : on peut générer des clés M2M sur un workspace platform-managed,
mais jamais les révoquer ni les lister.** `apiKeys.list` est aussi JWT-only
(testé 2026-06-14 : 401 "requires JWT authentication" avec une clé workspace).

C'est un vrai risque sécu : une clé fuitée/de test reste valide indéfiniment,
sans moyen propre de la couper.

## À faire

1. Ajouter `POST /api/admin/platform/workspaces.revokeApiKey` (PlatformAdminGuard M2M)
   body `{workspace_id, key_id?}` ou `{workspace_id, key_prefix?}` → révoque.
   Symétrique de provisionApiKey. Réutiliser `ApiKeysService.revoke` sans le @JwtOnly.
2. (optionnel) `workspaces.listApiKeys` M2M pour audit, même garde.
3. Une fois livré : révoquer les clés de test générées le 2026-06-14 sur
   `vrd_veridian_site_prod` (names e2e-prod-test-twenty, recheck-*, isol-test-*,
   cleanup*, audit-keys) — laisser seulement celles légitimement utilisées par
   le bridge/Hub.

## Contexte

Clés créées pendant les tests E2E prod du connecteur Twenty (2026-06-14). Pas de
fuite (jamais loggées, redaction OK vérifiée), mais clés actives non révocables =
dette sécu. Bloque tout cycle de vie propre des clés M2M (rotation incluse).

## Réponse — 2026-06-17 (agent-revoke)

**Étapes 1 + 2 LIVRÉES** sur `staging` (commit `530d0df`,
`feat(api): endpoint M2M revokeApiKey + listApiKeys [risk:high]`) :

- ✅ `POST /api/admin/platform/workspaces.revokeApiKey` (PlatformAdminGuard M2M),
  body `{workspace_id, key_id?|key_prefix?}`. Idempotent (re-revoke retry-safe),
  refuse la révocation cross-workspace (NotFound) et un prefix ambigu (Conflict).
  Le prefix est le handle visé (provisionApiKey ne renvoie pas l'id).
- ✅ `POST /api/admin/platform/workspaces.listApiKeys` (audit, metadata only,
  jamais le secret).
- ✅ Côté `ApiKeysService` : `revokeForPlatform` + `listForPlatform` +
  `resolveWorkspaceKey` (impose l'appartenance au workspace).
- ✅ Tests unitaires + e2e (cycle complet contre la vraie ClickHouse :
  provision → 200 → revoke par prefix → 401 → listée revoked → re-revoke idempotent).

**CI staging VERTE** (run `27688412950`) : tous étages success (Quick checks,
CVE bridge, Tests API/console/SDK/bridge, Trivy, Build, Deploy, Smoke).
Healthcheck `analytics-engine.staging.veridian.site/api/health` = 200.
Aucune migration → pas de GO migration requis.

**Étape 3 EN ATTENTE** : révoquer les clés de test sur la **prod**
`vrd_veridian_site_prod` (names `e2e-prod-test-twenty`, `recheck-*`,
`isol-test-*`, `cleanup*`, `audit-keys`). Nécessite la prod → laissée au
**team-lead post-promotion staging→main**. Le ticket reste **pending** jusqu'à
exécution de ce cleanup ; à archiver une fois les clés de test prod révoquées.
