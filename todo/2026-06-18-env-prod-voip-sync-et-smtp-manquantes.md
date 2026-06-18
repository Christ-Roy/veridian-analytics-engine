# 🔴 ENV prod : `VOIP_SYNC_ENABLED` absente du compose engine → Calls silencieusement mort

> **Sévérité** : 🔴 P0
> **Owner** : team-lead veridian-analytics-engine
> **Créé** : 2026-06-18
> **Source** : vérif ENV Dokploy prod réelle (composeId `RH8yiQGFLxTzVXtrvlNmB` = `analytics-engine-prod-gkggyk`) pendant la vague P1

## Constat (vérifié sur l'ENV Dokploy prod, pas supposé)

L'ENV du compose engine prod NE contient PAS `VOIP_SYNC_ENABLED`.

`api/src/voip/voip-sync.service.ts:43-51` :
```ts
private enabled(): boolean { return this.config.get('VOIP_SYNC_ENABLED') === 'true'; }
@Cron('0 */15 * * * *')
async scheduledSync() { if (!this.enabled()) return; await this.syncAll(); }
```
ENV absent → `enabled()` = false → le cron retourne early → **aucune synchro
automatique des call logs en prod**. La feature Calls (n°2 du scope commercial)
n'ingère JAMAIS un appel tout seul. Le bouton manuel UI (livré dans cette vague,
ticket A2) déclenche une synchro à la demande — mais un client qui ne clique pas
ne voit jamais ses appels remonter.

**Action** : poser `VOIP_SYNC_ENABLED=true` dans l'ENV Dokploy prod (et staging).

## ⚠️ Piège de mise en œuvre (mémoire `feedback_prod_ci_dokploy_async_pieges`)

`compose.update {env}` **REMPLACE l'ENV entier** (pas merge). Pour ajouter cette
var : fetch l'ENV courant via `compose.one`, AJOUTER la ligne, renvoyer le TOUT
via `compose.update`, puis `compose.deploy`. Ne jamais envoyer juste la nouvelle
ligne (ça effacerait les 23 autres vars → fail-closed `${VAR:?}`).

## Note SMTP (séparée — PAS dans ce ticket)

L'ENV n'a pas non plus `SMTP_*`. **MAIS** : décision Robert 2026-06-18 — le
transactionnel email est géré par l'app elle-même, zéro dépendance cross-app, et
on NE pose PAS un SMTP relai/Lark à la va-vite. Le câblage propre du canal email
de l'engine est un chantier à part, traité dans
`2026-06-17-arbitrer-subscriptions-rapports-email.md`. Ne PAS poser de SMTP ici.

## Statut
- [ ] Merge ENV (fetch complet) + ajout `VOIP_SYNC_ENABLED=true`
- [ ] `compose.update` (ENV complet mergé) + `compose.deploy` engine prod
- [ ] Vérifier : un appel remonte tout seul sous 15 min (ou via le bouton A2)
- [ ] Idem staging
