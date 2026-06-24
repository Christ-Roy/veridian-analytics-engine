# `tenants.provision` : workspace_id mal formé renvoie 409 au lieu de 400 (+ validation hors DTO)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Source** : audit comportemental M2M (probe-contracts)

## Symptôme reproductible

Sur `POST /api/admin/platform/tenants.provision`, un `workspace_id` explicite au
mauvais **format** (ex MAJ, tiret) renvoie un **409 Conflict** alors que le
workspace n'existe pas — c'est une erreur de **validation d'input**, donc 400.

```bash
curl -sS -X POST -H "Authorization: Bearer $PLATKEY" -H 'Content-Type: application/json' \
  -d '{"email":"a@b.fr","siteUrl":"https://x.fr","name":"Test Co","workspace_id":"Bad-ID"}' \
  "$BASE/api/admin/platform/tenants.provision"
# → HTTP 409
# {"error":"invalid_workspace_id","message":"Explicit workspace_id must match ^[a-z][a-z0-9_]*$ and be 2..50 chars."}
```

## Pourquoi c'est un mensonge de contrat

1. **409 = Conflict** = "la ressource existe déjà". Or ici le workspace **n'existe
   pas**, c'est le format qui est invalide. Le DTO documente d'ailleurs *"409 si
   déjà pris"* — donc le **même code 409 couvre deux causes distinctes** (déjà pris
   ET format invalide). Un consommateur (Hub) ne peut pas distinguer
   « réessaie avec un id libre » de « corrige ton format » → branchement d'erreur
   impossible.

2. **Validation à la mauvaise couche.** Le DTO `ProvisionTenantDto.workspace_id`
   n'a que `@IsOptional @IsString @Length(2,50)`. La regex `^[a-z][a-z0-9_]*$` est
   vérifiée **côté service** (`AdminPlatformService`, branche `invalid_workspace_id`).
   Conséquence : un id de bonne longueur mais mauvais format **passe la validation
   DTO** (pas de 400 propre) et échoue plus loin en 409 custom. Toutes les autres
   contraintes de format de la surface sont dans les DTO (`@Matches`, `@IsIn`,
   `@IsUrl`…) — celle-ci est l'exception.

## Correctif proposé

- Déplacer la contrainte regex dans le DTO via `@Matches(/^[a-z][a-z0-9_]*$/)`
  → 400 propre + message NestJS standard, cohérent avec le reste de la surface.
- Garder le **409 uniquement** pour le vrai conflit « workspace_id déjà pris ».
- Mettre à jour la docstring du DTO (qui mélange aujourd'hui les deux cas sous 409).

## Impact consommateur

Hub provisioning : si un id legacy adopté pendant la migration D2 a un format limite,
le Hub reçoit un 409 ambigu et peut le confondre avec « déjà migré ». Faible volume
mais piège réel sur le chemin migration.
