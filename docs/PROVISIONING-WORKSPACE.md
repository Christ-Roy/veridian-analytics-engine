# Provisioning d'un workspace pour un site Veridian

Procédure pour créer un workspace analytics-engine destiné à ingérer les
events tracker d'un **site statique Veridian** (veridian.site, vergers,
boulangerie cliente, etc.) — workspace **platform-managed**, sans owner
humain, sans email de magic link, sans API key utilisateur.

> Pour provisionner un workspace **client** (avec user owner + magic link +
> API key + email transactionnel), utiliser l'endpoint M2M
> `POST /api/admin/platform/tenants.provision` (cf `PLATFORM-ADMIN-API.md`).
> Cette doc concerne uniquement les workspaces que **Veridian elle-même**
> détient pour ses propres sites publics.

## Convention de nommage

Format strict : `vrd_<sitename>_<env>`

| Site | Staging | Prod |
|---|---|---|
| veridian.site | `vrd_veridian_site_staging` | `vrd_veridian_site_prod` |
| vergers.veridian.site | `vrd_vergers_staging` | `vrd_vergers_prod` |
| (futur client X) | `vrd_<slug>_staging` | `vrd_<slug>_prod` |

Contraintes héritées de `CreateWorkspaceDto` :
- regex `^[a-z][a-z0-9_]*$`
- longueur 2..50 caractères
- ClickHouse remplace `-` par `_` dans le nom de DB (donc éviter les `-`)

## Procédure (script Node one-shot dans le container engine)

Le script `api/scripts/provision-workspace.js` est embarqué dans l'image
engine (build context inclut `api/scripts/`). Il reproduit fidèlement les
étapes 1 + 2 de `WorkspacesService.create()` :

1. `CREATE DATABASE staminads_ws_<id>` + toutes les tables/MV workspace
   (events, sessions, sessions_mv, pages, pages_mv, goals, goals_mv)
2. `INSERT` dans `staminads_system.workspaces` avec `status='active'`

**Skip volontaire** :
- pas de `workspace_memberships` (no human owner — visible uniquement par
  les super-admins via la branche "all workspaces" de
  `WorkspacesService.list`)
- pas de `backfill_tasks` (no filters configured, no UI warning à
  supprimer)
- pas de user / api_key / email

Idempotent : si le workspace existe déjà, le script log + skip l'INSERT
mais re-applique les CREATE TABLE IF NOT EXISTS (safe).

### Staging

```bash
ssh dev-pub 'docker exec analytics-engine-staging-engine-1 \
  node /app/scripts/provision-workspace.js \
    --id=vrd_<slug>_staging \
    --name="<Nom Lisible> (staging)" \
    --website=https://<domaine-staging>'
```

### Prod

```bash
ssh prod-pub 'sudo docker exec analytics-engine-prod-gkggyk-engine-1 \
  node /app/scripts/provision-workspace.js \
    --id=vrd_<slug>_prod \
    --name="<Nom Lisible>" \
    --website=https://<domaine-prod>'
```

### Smoke post-provisioning (obligatoire)

```bash
NOW=$(date +%s)000 && PREV=$((NOW - 10000))
curl -sS -w "\nHTTP=%{http_code}\n" -X POST \
  https://analytics-engine.staging.veridian.site/api/track \
  -H "Content-Type: application/json" \
  -d "{
    \"workspace_id\": \"vrd_<slug>_staging\",
    \"session_id\": \"smoke-$(date +%s)\",
    \"actions\": [{
      \"type\": \"pageview\",
      \"path\": \"/smoke\",
      \"page_number\": 1,
      \"duration\": 5000,
      \"scroll\": 50,
      \"entered_at\": $PREV,
      \"exited_at\": $NOW
    }],
    \"created_at\": $PREV,
    \"updated_at\": $NOW,
    \"attributes\": {\"landing_page\": \"https://<domaine>/smoke\"}
  }"
# attendu: {"success":true} HTTP=200
```

Vérifier que l'event a bien atteint ClickHouse :

```bash
ssh dev-pub 'docker exec analytics-engine-staging-clickhouse-1 \
  clickhouse-client --query "SELECT session_id, name, path FROM \
  staminads_ws_vrd_<slug>_staging.events ORDER BY received_at DESC LIMIT 5"'
```

## Variables d'env côté site

Une fois le workspace provisionné, brancher le tracker côté site Next.js :

```env
# .env.production
NEXT_PUBLIC_ANALYTICS_WORKSPACE_ID=vrd_<slug>_prod
NEXT_PUBLIC_ANALYTICS_ENDPOINT=https://analytics-engine.app.veridian.site

# .env.staging (ou preview)
NEXT_PUBLIC_ANALYTICS_WORKSPACE_ID=vrd_<slug>_staging
NEXT_PUBLIC_ANALYTICS_ENDPOINT=https://analytics-engine.staging.veridian.site
```

Le SDK tracker n'embarque PAS d'API key (CORS-permissive sur `/api/track*`).
Seul le `workspace_id` est nécessaire.

## Workspaces actuellement provisionnés (2026-06-02)

| Workspace ID | Env | Container ClickHouse |
|---|---|---|
| `vrd_veridian_site_staging` | staging | analytics-engine-staging-clickhouse-1 |
| `vrd_veridian_site_prod` | prod | analytics-engine-prod-gkggyk-clickhouse-1 |

## Limitations connues (à durcir plus tard)

- **Pas d'endpoint M2M dédié** pour ce type de workspace platform-managed.
  L'endpoint `POST /api/admin/platform/tenants.provision` impose user +
  email + slug auto, ce qui ne colle pas au cas "site Veridian sans owner
  humain". Si on en provisionne > 5, ouvrir un ticket pour ajouter une
  variante `POST /api/admin/platform/workspaces.provision` qui prend un
  `id` explicite et skip la création user.
- **Pas de membership** = le workspace n'est visible que par les
  super-admins dans l'UI staminads. Volontaire — ces workspaces ne sont
  pas destinés à être ouverts à un client.
