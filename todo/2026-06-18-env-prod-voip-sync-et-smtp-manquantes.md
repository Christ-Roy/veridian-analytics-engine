# 🔴 ENV prod manquantes : `VOIP_SYNC_ENABLED` et `SMTP_HOST` absentes du compose engine

> **Sévérité** : 🔴 P0 (VOIP_SYNC_ENABLED) + 🟡 P1 (SMTP_HOST)
> **Owner** : team-lead veridian-analytics-engine
> **Créé** : 2026-06-18
> **Source** : vérif ENV Dokploy prod réelle (composeId `RH8yiQGFLxTzVXtrvlNmB` = `analytics-engine-prod-gkggyk`) pendant la vague P1

## Constat (vérifié sur l'ENV Dokploy prod, pas supposé)

L'ENV du compose engine prod NE contient NI `VOIP_SYNC_ENABLED` NI `SMTP_HOST`.

### 1. `VOIP_SYNC_ENABLED` absent → Calls silencieusement mort (P0)

`api/src/voip/voip-sync.service.ts:43-51` :
```ts
private enabled(): boolean { return this.config.get('VOIP_SYNC_ENABLED') === 'true'; }
@Cron('0 */15 * * * *')
async scheduledSync() { if (!this.enabled()) return; await this.syncAll(); }
```
ENV absent → `enabled()` = false → le cron retourne early → **aucune synchro
automatique des call logs en prod**. La feature Calls (n°2 du scope commercial)
n'ingère JAMAIS un appel tout seul. Seul le bouton manuel UI (ticket A2 de cette
vague) déclenche une synchro — mais un client qui ne clique pas ne voit jamais
ses appels remonter.

**Action** : poser `VOIP_SYNC_ENABLED=true` dans l'ENV Dokploy prod (et staging).

### 2. `SMTP_HOST` absent → 3 modules neutralisés (P1)

`compose/base.yml:65` : `SMTP_HOST=${SMTP_HOST:-}` (défaut vide). ENV prod ne le
pose pas. Conséquences :
- **subscriptions** (rapports email — gardés par décision Robert 2026-06-18) :
  le cron `@Cron('0 */15')` échoue en boucle (`smtpService.getInfo()` fail-fast),
  pollue `audit_logs` de `subscription.report_failed`.
- **invitations** (flow membre) : email non envoyé.
- **magic-link de provisioning M2M** : le client ne reçoit pas son lien.

**Action** : poser `SMTP_HOST` + creds réels (relai Veridian, skill `postfix` /
Brevo SMTP selon le canal retenu) dans l'ENV Dokploy prod (et staging).

## ⚠️ Piège de mise en œuvre (mémoire `feedback_prod_ci_dokploy_async_pieges`)

`compose.update {env}` **REMPLACE l'ENV entier** (pas merge). Pour ajouter ces 2
vars : fetch l'ENV courant via `compose.one`, AJOUTER les lignes, renvoyer le
TOUT via `compose.update`, puis `compose.deploy`. Ne jamais envoyer juste les 2
nouvelles lignes (ça effacerait les 23 autres vars → fail-closed `${VAR:?}`).

## Statut
- [ ] Récupérer les vraies valeurs SMTP (relai Veridian)
- [ ] Merge ENV + ajout `VOIP_SYNC_ENABLED=true` + `SMTP_HOST=...` (+ SMTP_PORT/USER/PASS/FROM selon le code)
- [ ] `compose.update` (ENV complet mergé) + `compose.deploy` engine prod
- [ ] Vérifier : un appel remonte tout seul sous 15 min + un rapport email part
- [ ] Idem staging
