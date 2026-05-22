# Checklist pré-migration — 5 clients prod (ticket D2)

> À dérouler **intégralement** AVANT de lancer un seul script en `--apply`.
> Cocher chaque case. Si une case ne peut pas être cochée → STOP, escalader
> à Robert.

La migration RÉELLE est une **décision Robert** — cette checklist est l'outil
qu'il (ou un agent mandaté) suit le jour J.

---

## A. Pré-requis techniques

- [ ] Le ticket D2 dépend de **A1 + A2 + A3 + B1 livrés** sur `staging` — vérifié.
- [ ] Le **patch staminads visitor_id (Phase 2)** est livré et déployé sur
      l'engine prod. Sans lui, le snippet `data-visitor-id="true"` n'a aucun
      effet runtime. → vérifier la migration ClickHouse V7 appliquée
      (`api/src/migrations/`).
- [ ] L'endpoint `POST /api/admin/provision-existing-tenant` est déployé sur
      le bridge prod (ce ticket) — `curl` de health OK.
- [ ] Le bridge prod a `BRIDGE_DATABASE_URL` configuré (sinon la route est
      désactivée — cf. `src/index.ts`).

## B. Snapshots / sauvegardes (RÉVERSIBILITÉ)

- [ ] **Snapshot Postgres bridge** pris AVANT toute écriture :
      ```bash
      pg_dump "$BRIDGE_DATABASE_URL" -Fc -f bridge-pre-migration-$(date +%F).dump
      ```
- [ ] **Snapshot Postgres legacy** (lecture seule pour la migration, mais on
      sécurise) :
      ```bash
      pg_dump "$LEGACY_DATABASE_URL" -n analytics -Fc -f legacy-pre-migration-$(date +%F).dump
      ```
- [ ] Snapshot staminads/ClickHouse — au minimum noter l'état (la migration
      ne touche pas ClickHouse, mais crée des workspaces).

## C. Résolution des données

- [ ] Les 5 `legacySiteKey` dans `lib/clients.ts` sont **résolus** (plus aucun
      placeholder `RESOLVE_*`). Le script `migrate-existing-tenants.ts` refuse
      de tourner en `--apply` sinon — c'est un garde-fou, pas un bug.
- [ ] Les dumps legacy sont produits (cf. README §"Étape 2") si on migre
      l'historique GSC/Forms.
- [ ] Les `domain` de `lib/clients.ts` correspondent aux domaines réels.

## D. Clés et secrets

- [ ] `VERIDIAN_ADMIN_API_KEY` du bridge prod en main (depuis
      `~/credentials/.all-creds.env` ou Dokploy ENV).
- [ ] `BRIDGE_DATABASE_URL` prod en main pour les scripts d'historique.
- [ ] **Clés VAPID identiques** legacy ↔ bridge — si on migre les
      `PushSubscription`, les clés VAPID du bridge DOIVENT être les mêmes que
      celles du legacy (`veridian-analytics/lib/web-push.ts`), sinon tous les
      abonnements push deviennent invalides. Vérifier
      `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`.
- [ ] Token Telegram pour l'alerting (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`).

## E. Dry-run obligatoire

- [ ] `migrate-existing-tenants.ts` lancé en **dry-run** — la sortie liste
      bien les 5 clients, les workspaceId attendus, et génère
      `out/snippets-by-site.md` sans erreur.
- [ ] `migrate-gsc-history.ts` en dry-run (si historique migré) — compte de
      rows cohérent avec la DB legacy.
- [ ] `migrate-forms-history.ts` en dry-run (si historique migré) — compte de
      leads/submissions cohérent.

## F. Communication clients externes

- [ ] Email à **Tramtech** (tramtech-depannage.fr) rédigé avec le snippet —
      **validé par Robert AVANT envoi**.
- [ ] Email à **Arnaud** (arnaudcapitaine.com) rédigé avec le snippet —
      **validé par Robert AVANT envoi**.
- [ ] Pour les 3 sites Veridian-hosted : PR préparée sur le repo de chaque
      site (ou agent dédié briefé).

## G. Exécution

- [ ] Étape 1 (`--apply`) : provisionning — les 5 workspaces créés, vérifiés
      en DB bridge.
- [ ] Étapes 3-4 (`--apply`, optionnel) : historique GSC + Forms importé.
- [ ] Étape 5 : snippets posés sur les 5 sites, validés en Chrome incognito
      (0 erreur JS, 2 trackers en parallèle).
- [ ] Étape 6 : cron d'alerte dual-tracking installé sur dev-pub.

## H. Post-migration (J0 → J+30)

- [ ] Dashboard `/admin/migration-diff` (côté legacy) montre les 2 courbes
      par tenant — écart sous 10 %.
- [ ] Alerte Telegram quotidienne fonctionnelle (test manuel :
      `systemctl start migration-diff-alert.service`).
- [ ] 30 jours d'observation **sans alerte rouge persistante** avant
      d'envisager le cutover (ticket S3 séparé — NE PAS retirer le tracker
      legacy avant).
- [ ] Tag git `v0.3.0-dual-tracking-live` posé une fois les 5 snippets en
      place et le dual-tracking confirmé.

---

## Garde-fous intégrés aux scripts (rappel)

| Garde-fou | Effet |
|---|---|
| dry-run par défaut | aucune écriture sans `--apply` explicite |
| `--apply` + `--dry-run` ensemble | erreur immédiate |
| `siteKey` placeholder `RESOLVE_*` | `migrate-existing-tenants --apply` refuse de tourner |
| idempotence (upsert / created:false) | rejouer un script ne duplique rien |
| `BRIDGE_URL`/`VERIDIAN_ADMIN_API_KEY` manquants en `--apply` | erreur, exit 1 |
