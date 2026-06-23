# 🟡 Cap directeur : parité API M2M ↔ capacité (IA-first) — vague 1 LIVRÉE, reste F2 Ads + SSO

> **Sévérité** : 🟡 P1 (cap produit — la majeure partie est livrée, ce ticket reste comme garde-fou de cap)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-20 · **Dégraissé** : 2026-06-23 (90% livré)

## Cap (Robert 2026-06-18/20)
L'app doit être **IA-first / API-first** : toute capacité pilotable en S2S via API sécurisée, pour
qu'une IA (puis une couche MCP) provisionne et administre un client de A à Z sans UI. Axe directeur :
**chaque feature backend a son endpoint M2M propre et complet**.

## ✅ LIVRÉ (vérifié prod 2026-06-23 — NE PAS refaire)
- **Bug snippet corrigé** : `buildTrackerSnippet` émet bien `/sdk/v1/tracker.js` (commit `ffce3db`).
  Vérifié : `workspaces.status` renvoie le snippet correct, content-type `application/javascript`.
- **22 endpoints M2M** `/api/admin/platform/*` (Bearer `PLATFORM_ADMIN_API_KEY`), commit `c4ae45b` :
  `tenants.provision`, `workspaces.{provisionApiKey,revokeApiKey,listApiKeys,status,updateSettings}`,
  `analytics.query`, VoIP M2M (8 : list/add/remove + creds CRUD + sync), GSC M2M (`gsc.status/resync`),
  webhooks M2M (`webhooks.list/create/delete/test` → branche le tunnel CRM en S2S), `ads.conversions` (lecture).
  Auth Bearer timing-safe (`PlatformAdminGuard`), `workspace_id` requis, secrets jamais renvoyés (vues `Public*`).
  Vérifié : `analytics doctor --env prod` → auth M2M OK ; `status vrd_veridian_site_prod` → état consolidé OK.

## Reste à faire (tout absorbé dans des chantiers dédiés — ce ticket = juste le suivi de cap)
- **F2 — Upload conversions Google Ads (S2S)** → couvert par `CHANTIER-attribution-bout-en-bout.md` **S5**
  (l'engine expose `ads.conversions` ; l'upload reste au skill plateforme `google-ads`).
- **SSO autologin Hub** → ticket dédié `2026-06-22-sso-autologin-hub-issue-token.md` (`HUB_HMAC_SECRET`
  posé en ENV mais utilisé NULLE PART dans le code — vérifié 2026-06-23).
- **Config workspace par API (branding/features/layout/mapping CRM)** → ticket dédié
  `2026-06-23-ui-configurable-par-workspace-branding-features-widgets.md` (gros chantier, N4 = mapping CRM).

## Garde-fou de cap (raison de garder ce ticket)
Toute NOUVELLE capacité backend ajoutée à l'engine DOIT exposer son endpoint M2M dans la même vague
(pas d'UI-only). Sécurité sur toute nouvelle surface M2M : Bearer timing-safe, `workspace_id` explicite
(pas d'énumération globale), DTO `class-validator`, SSRF si URL en entrée, secrets write-only.
Mettre à jour le skill `analytics` (cf `2026-06-22-skill-analytics-restructurer-index.md`) à chaque ajout.
