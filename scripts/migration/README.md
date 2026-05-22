# Migration des 5 clients prod — staminads + dual-tracking (ticket D2)

> **Statut** : scripts livrés, testés, prêts à l'emploi.
> **La migration RÉELLE n'a PAS été exécutée** — c'est une décision Robert
> séparée (opération sur données de prod, partiellement irréversible).

Ce dossier contient tout le nécessaire pour migrer les 5 clients prod du
stack analytics legacy (`veridian-analytics`) vers le nouveau moteur
(`veridian-analytics-engine` / staminads), en **dual-tracking** : les deux
trackers tournent en parallèle pendant 30 jours avant le cutover.

---

## Les 5 clients

| Slug | Domaine | Hosting | PV 30j legacy |
|---|---|---|---|
| `avse-monetique` | avse-monetique.veridian.site | Veridian | 1504 |
| `morel-volailles-com` | morel-volailles.com | Veridian | 674 |
| `robert-deboucheur` | robert-deboucheur.fr | Veridian | 270 |
| `tramtech-depannage-fr` | tramtech-depannage.fr | Externe (Tramtech) | 87 |
| `arnaudcapitaine-com` | arnaudcapitaine.com | Externe (Arnaud) | 0 |

La liste est figée dans [`lib/clients.ts`](./lib/clients.ts).

---

## Fichiers

```
scripts/migration/
├── README.md                      ← ce fichier
├── CHECKLIST.md                   ← checklist pré-migration (à suivre le jour J)
├── migrate-existing-tenants.ts    ← (1) provisionne les workspaces + génère les snippets
├── migrate-gsc-history.ts         ← (2) importe l'historique Search Console
├── migrate-forms-history.ts       ← (3) importe l'historique formulaires/leads
├── migration-diff-alert.ts        ← (4) alerte Telegram si l'écart dual-tracking dérape
├── cron/
│   ├── install-diff-alert-cron.sh ← installe le cron d'alerte sur dev-pub
│   ├── migration-diff-alert.service
│   └── migration-diff-alert.timer
├── lib/                           ← logique pure, testée unitairement
│   ├── clients.ts                 ← liste des 5 clients + garde placeholder
│   ├── mapping.ts                 ← transformations legacy → bridge
│   ├── dual-tracking.ts           ← génération des snippets
│   ├── diff-alert.ts              ← logique de seuil 10 % / 3 jours
│   ├── forms-stats.ts             ← recompte submissionsCount
│   ├── dump-io.ts                 ← lecture des dumps JSON legacy
│   └── cli.ts                     ← parsing flags + logging
└── out/                           ← (généré) snippets-by-site.md
```

Tests : `veridian-bridge/tests/migration/*.test.ts` (lancés par le pre-push
et la CI bridge — `npm run test:ci` côté `veridian-bridge`).

---

## ⚠️ Sécurité — dry-run par défaut

**Tous les scripts tournent en `--dry-run` par défaut.** Aucune écriture
sans le flag `--apply` explicite. Passer `--apply` ET `--dry-run` ensemble
provoque une erreur.

```bash
npx tsx scripts/migration/migrate-existing-tenants.ts            # dry-run, lecture seule
npx tsx scripts/migration/migrate-existing-tenants.ts --apply    # exécution réelle
```

## ▶️ Où lancer les scripts

Les scripts utilisent `tsx` et (pour l'historique) le client Prisma — tous
deux fournis par `veridian-bridge/node_modules`. **Lancer les commandes
depuis le dossier `veridian-bridge/`** pour que la résolution de modules
fonctionne :

```bash
cd veridian-analytics-engine/veridian-bridge
npx tsx ../scripts/migration/migrate-existing-tenants.ts
```

(Les exemples ci-dessous sont écrits depuis la racine du repo pour la
lisibilité — préfixer mentalement `cd veridian-bridge &&` et adapter le
chemin du script en `../scripts/migration/...`.)

---

## Ordre d'exécution le jour J

> ⚠️ **Avant tout** : dérouler [`CHECKLIST.md`](./CHECKLIST.md) en entier.

### Étape 0 — résoudre les `siteKey` legacy

`lib/clients.ts` contient des `legacySiteKey` **placeholder** (`RESOLVE_*`).
Les scripts refusent de tourner en `--apply` tant qu'ils ne sont pas
remplacés par les vraies valeurs. Les récupérer :

```bash
psql "$LEGACY_DATABASE_URL" -t -A -F',' -c \
  "SELECT t.slug, s.\"siteKey\", s.domain
     FROM analytics.\"Site\" s
     JOIN analytics.\"Tenant\" t ON t.id = s.\"tenantId\"
    WHERE t.\"deletedAt\" IS NULL
      AND t.slug IN ('avse-monetique','morel-volailles-com',
                     'robert-deboucheur','tramtech-depannage-fr',
                     'arnaudcapitaine-com');"
```

Reporter chaque `siteKey` dans `lib/clients.ts` (champ `legacySiteKey`),
commit, push.

### Étape 1 — provisionner les workspaces staminads

Crée un workspace staminads + un `Tenant`/`Site` bridge pour chaque client,
en réutilisant le `siteKey` legacy. **Idempotent** — rejouable sans doublon.

```bash
# Dry-run d'abord (vérifie ce qui serait fait) :
npx tsx scripts/migration/migrate-existing-tenants.ts

# Puis en réel :
BRIDGE_URL=https://analytics-engine-bridge.app.veridian.site \
VERIDIAN_ADMIN_API_KEY=<clé admin bridge> \
  npx tsx scripts/migration/migrate-existing-tenants.ts --apply
```

Sortie : `scripts/migration/out/snippets-by-site.md` — un bloc HTML
dual-tracking par client (tracker legacy + tracker staminads).

### Étape 2 — produire les dumps legacy (pour l'historique)

Les scripts d'historique (étapes 3 et 4) consomment des **dumps JSON** des
tables legacy — ils ne se connectent PAS directement à la DB legacy (pas de
dépendance `pg`, scripts rejouables hors-ligne).

Produire les dumps avec `psql` (NDJSON, une ligne par row) :

```bash
DUMP_DIR=./scripts/migration/out/dumps
mkdir -p "$DUMP_DIR"

dump() {
  psql "$LEGACY_DATABASE_URL" -t -A -c \
    "SELECT row_to_json(x) FROM ($1) x" > "$DUMP_DIR/$2.json"
}

dump 'SELECT id,"siteKey" FROM analytics."Site"' site
dump 'SELECT id,"siteId","propertyUrl","lastSyncAt" FROM analytics."GscProperty"' gsc-property
dump 'SELECT id,"siteId",day,query,page,country,device,"searchType",clicks,impressions,ctr,position FROM analytics."GscDaily"' gsc-daily
dump 'SELECT id,"siteId","formName",fields FROM analytics."FormSchema"' form-schema
dump 'SELECT id,"tenantId","siteId",email,phone,name,"firstSeenAt","lastSeenAt" FROM analytics."Lead"' lead
dump 'SELECT id,"siteId","formName",path,payload,email,phone,"sessionId","leadId","createdAt" FROM analytics."FormSubmission"' form-submission
dump 'SELECT id,"leadId","sessionId","siteId","firstSeenAt","lastSeenAt","pageviewCount" FROM analytics."LeadSession"' lead-session
```

### Étape 3 — importer l'historique GSC (optionnel)

```bash
# Dry-run :
LEGACY_SITE_DUMP=./scripts/migration/out/dumps/site.json \
GSC_PROPERTY_DUMP=./scripts/migration/out/dumps/gsc-property.json \
GSC_DAILY_DUMP=./scripts/migration/out/dumps/gsc-daily.json \
  npx tsx scripts/migration/migrate-gsc-history.ts

# Réel :
BRIDGE_DATABASE_URL=<postgres bridge> \
LEGACY_SITE_DUMP=... GSC_PROPERTY_DUMP=... GSC_DAILY_DUMP=... \
  npx tsx scripts/migration/migrate-gsc-history.ts --apply
```

### Étape 4 — importer l'historique formulaires/leads (optionnel)

```bash
BRIDGE_DATABASE_URL=<postgres bridge> \
LEGACY_SITE_DUMP=... FORM_SCHEMA_DUMP=... LEAD_DUMP=... \
FORM_SUBMISSION_DUMP=... LEAD_SESSION_DUMP=... \
  npx tsx scripts/migration/migrate-forms-history.ts --apply
```

> **Pas migrés** (décision Robert, ticket D2 §6) : `Pageview` et `SipCall`.
> Staminads démarre à J0 pour les pageviews — l'historique de trafic reste
> consultable côté legacy pendant la transition.

### Étape 5 — poser les snippets côté sites

À partir de `out/snippets-by-site.md` :

- **Sites Veridian-hosted (3)** : PR sur le repo du site, ajouter le bloc
  staminads dans le `<head>` du layout — **garder le tracker legacy**.
- **Sites externes (2)** : email à Tramtech / Arnaud (validé par Robert
  AVANT envoi) avec le snippet staminads à coller dans leur thème.

Validation immédiate par site (Chrome, mode incognito) :
1. Console : 0 erreur JS.
2. Les 2 trackers tirent en parallèle (`/api/ingest/pageview` legacy +
   `/api/track` staminads dans l'onglet Réseau).
3. Vérifier que le pageview arrive sur le bon workspace staminads.

### Étape 6 — installer l'alerte dual-tracking

Sur dev-pub, pour les 30 jours d'observation :

```bash
ssh dev-pub
bash /chemin/scripts/migration/cron/install-diff-alert-cron.sh
sudo nano /etc/veridian/migration-diff-alert.env   # remplir Telegram + MIGRATION_DIFF_FILE
```

Le cron tourne tous les jours à 08:00 UTC. Il alerte si l'écart pageviews
legacy/staminads dépasse **10 % pendant 3 jours consécutifs** sur un tenant.

---

## Idempotence — pourquoi on peut rejouer

| Script | Garantie d'idempotence |
|---|---|
| `migrate-existing-tenants` | l'endpoint `provision-existing-tenant` renvoie le mapping existant si le `Site` a déjà été adopté (`created:false`) |
| `migrate-gsc-history` | `upsert` sur `@@unique(tenantId,siteUrl)` et `@@unique(gscPropertyId,date,query,page,country,device,searchType)` |
| `migrate-forms-history` | `upsert` sur `@@unique(siteId,formSlug)`, `@@unique(siteId,email)`, et par PK pour submissions/sessions |
| `migration-diff-alert` | lecture seule — aucune écriture |

Les IDs legacy (`id` des rows) sont **conservés** côté bridge → rejouer un
script ne crée jamais de doublon, il met à jour la row existante.

---

## Rollback

La migration est **additive** : on ne supprime ni ne modifie rien côté
legacy. Le tracker legacy reste en place pendant les 30 jours.

| Quoi annuler | Comment |
|---|---|
| Workspace staminads créé par erreur | `DELETE` du workspace côté staminads + de la row `Tenant`/`Site` bridge (snapshot Postgres bridge pris en checklist étape "snapshot") |
| Historique GSC/Forms importé en double | impossible (upsert idempotent) — sinon restaurer le snapshot bridge |
| Snippet posé sur un site | retirer le bloc `<script>` staminads du `<head>` (le legacy continue de tourner seul) |
| Cutover prématuré | NE PAS retirer le tracker legacy avant 30j d'observation verte |

Le seul point réellement irréversible serait la **suppression du tracker
legacy** au cutover J+30 — c'est l'objet du ticket S3 séparé, pas de ce
ticket.

---

## Vérification post-migration

```bash
# 1. Les 5 Tenant/Site existent côté bridge :
psql "$BRIDGE_DATABASE_URL" -c \
  'SELECT t.slug, s."siteKey", s.domain, t."workspaceId"
     FROM "Site" s JOIN "Tenant" t ON t.id = s."tenantId";'

# 2. Health bridge :
curl -s https://analytics-engine-bridge.app.veridian.site/health

# 3. Les pageviews staminads arrivent (par client) — via le dashboard
#    /admin/migration-diff côté legacy, ou la query staminads analytics.
```
