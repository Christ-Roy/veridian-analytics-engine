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
