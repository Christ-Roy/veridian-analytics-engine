# Surface M2M : 5 shapes d'erreur différents pour un même consommateur

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Source** : audit comportemental M2M (probe-contracts)

## Symptôme reproductible

Les 31 routes `/api/admin/platform/*` renvoient leurs erreurs sous **5 conventions
JSON différentes**. Un consommateur générique (Hub, IA, CLI `analytics`) qui veut
parser « est-ce une erreur, laquelle » doit gérer 5 formes. Reproductions réelles
(staging, 2026-06-24) :

| # | Cas | HTTP | Body |
|---|---|---|---|
| 1 | Validation (body vide, enum hors-liste…) | 400 | `{"message":[...],"error":"Bad Request","statusCode":400}` |
| 2 | Workspace inexistant (getCustomization, listApiKeys, gsc.status, voip.*, webhooks.list, crm.getMapping) | 404 | `{"error":"workspace_not_found","message":"..."}` *(pas de `statusCode`)* |
| 3 | VoIP credential / webhook absent (voip.testCredential, webhooks.test, webhooks.delete) | 404 | `{"code":"CREDENTIAL_NOT_FOUND","message":"..."}` / `{"code":"WEBHOOK_NOT_FOUND",...}` *(clé `code`, ni `error` ni `statusCode`)* |
| 4 | API key prefix introuvable (revokeApiKey) | 404 | `{"message":"...","error":"Not Found","statusCode":404}` *(NestJS standard)* |
| 5 | workspace_id mal formé (tenants.provision) | 409 | `{"error":"invalid_workspace_id","message":"..."}` |

Trois 404 (#2, #3, #4) avec **trois shapes différents**. La clé discriminante du
type d'erreur est tantôt `error` (slug), tantôt `code`, tantôt `error` (libellé
HTTP humain). Le champ `statusCode` est présent dans #1/#4 mais absent de #2/#3/#5.

```bash
# 3 façons d'apprendre "pas trouvé", 3 parseurs nécessaires :
... voip.testCredential {"workspace_id":"<ws>","kind":"voip_ovh"}   # → {"code":"CREDENTIAL_NOT_FOUND",...}
... workspaces.listApiKeys {"workspace_id":"ghost"}                  # → {"error":"workspace_not_found",...}
... workspaces.revokeApiKey {"workspace_id":"<ws>","key_prefix":"x"} # → {"error":"Not Found","statusCode":404,...}
```

## Pourquoi c'est un mensonge de contrat

Aucune des sources (SKILL.md, DTO, controller) ne documente un format d'erreur
canonique. Le SKILL annonce seulement « 401/404/400/409 » mais pas la **forme du
corps**. Un agent IA qui code `if (resp.error === 'workspace_not_found')` rate les
404 `code:*`, et inversement. Le CLI `analytics` masque ça en mappant tout sur un
exit code, mais tout autre consommateur (Hub) est exposé.

## Correctif proposé

Choisir **une** convention d'erreur et l'imposer via un `ExceptionFilter` global
sur le controller M2M (ou réutiliser celui de NestJS). Reco : forme NestJS standard
`{statusCode, error, message, code?}` partout, avec un `code` machine-stable
optionnel (`WORKSPACE_NOT_FOUND`, `CREDENTIAL_NOT_FOUND`…) pour le branchement IA.
Puis documenter ce contrat d'erreur dans le SKILL.md (section « formes d'erreur »).

## Impact consommateur

Branchement d'erreur fragile côté Hub/IA. Pas de casse fonctionnelle aujourd'hui
(le happy-path marche), mais toute logique de retry/diagnostic automatique sur ces
routes est non-fiable tant que les formes divergent.
