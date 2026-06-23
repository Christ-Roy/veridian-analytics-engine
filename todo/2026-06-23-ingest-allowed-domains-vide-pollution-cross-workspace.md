# `allowed_domains` vide → tout passe : pollution cross-workspace par défaut

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

Le `workspace_id` est public par nature (en clair dans le snippet tracker). La
seule barrière anti-pollution sur `/api/track` est `isDomainAllowed`, qui compare
l'`Origin`/`Referer` à `workspace.settings.allowed_domains`.

Deux problèmes :

1. **Défaut grand ouvert** : si `allowed_domains` est vide (le défaut),
   `isDomainAllowed` fait `return true` (`session-payload.handler.ts:528-531`) →
   **tout passe, depuis n'importe quelle source**.
2. **Header spoofable hors navigateur** : `Origin`/`Referer` sont librement
   falsifiables par curl/script. Le commentaire `session-payload.handler.ts:56`
   ("not spoofable") est **faux** hors contexte browser. Un attaquant met
   `Origin: https://siteclient.fr` et spamme le workspace d'un concurrent.

Résultat : sabotage des stats d'un concurrent / pollution de la donnée facturée,
surtout sur les workspaces sans `allowed_domains` configuré (cas par défaut).

## Localisation (fichiers + lignes)

- `api/src/events/session-payload.handler.ts:56-65` — gating Origin/Referer
- `api/src/events/session-payload.handler.ts:528-531` — `allowed_domains` vide → `return true`

## Correctif proposé

1. Forcer `allowed_domains` non vide à la création de workspace (défaut = le
   website du client, déjà connu au provisioning).
2. Corriger le commentaire trompeur ("not spoofable" → "best-effort, spoofable
   hors browser").
3. Documenter que le domain-check est un filtre best-effort, pas une frontière de
   sécurité — le vrai rempart anti-pollution massive reste le rate-limit infra
   (ticket `2026-06-23-ingest-track-aucun-ratelimit-dos.md`).

Un endpoint public sans token ne peut pas être "parfaitement" protégé, mais
aujourd'hui il est grand ouvert quand `allowed_domains` est vide — ce qui est le
défaut.

## ✅ Résolu 2026-06-23

Politique retenue (équilibre fermeture / non-régression) :

1. **Nouveaux workspaces fermés par défaut** : `WorkspacesService.create()` seede
   `allowed_domains` depuis le `website` du client (déjà connu au provisioning)
   via `deriveAllowedDomains()` → `['*.<apex>']` (wildcard couvrant apex + www +
   sous-domaines, vérifié contre `isDomainAllowed`). Si le caller fournit un
   `allowed_domains` explicite (y compris `[]`) on le respecte — opt-in allow-all
   conscient. La démo (`demo.service.ts`) construit son workspace hors `create()`
   et garde son propre `['*.apple.com']` — non affectée.
2. **Workspaces existants (allowed_domains vide = 332 sessions réelles) non
   cassés** : "vide ⇒ accepte" est CONSERVÉ mais passe désormais un
   `logger.warn` ("allowed_domains empty") au lieu d'accepter silencieusement →
   l'exposition est visible en logs sans bloquer l'ingestion légitime.
3. **Commentaire trompeur corrigé** : `session-payload.handler.ts` ne dit plus
   "not spoofable" — le domain-check est documenté comme best-effort, spoofable
   hors browser ; le vrai rempart anti-flood reste le rate-limit infra
   (ticket `2026-06-23-ingest-track-aucun-ratelimit-dos.md`, séparé).

Tests ajoutés : `workspaces.service.spec.ts` (seed depuis website + respect du
`[]` explicite), `session-payload.handler.spec.ts` (warn quand vide). Fichiers :
`api/src/workspaces/entities/workspace.entity.ts` (`deriveAllowedDomains`),
`api/src/workspaces/workspaces.service.ts` (seed au create),
`api/src/events/session-payload.handler.ts` (warn + commentaire).

## Impact si non corrigé

Pollution / sabotage des stats par défaut sur tout workspace dont
`allowed_domains` n'est pas renseigné. Donnée facturée corruptible par un tiers.
