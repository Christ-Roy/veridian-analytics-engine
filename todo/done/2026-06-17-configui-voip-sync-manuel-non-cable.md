# 🟡 VoIP : le déclenchement de synchro manuel existe au backend mais n'a aucun bouton dans le panel Settings

> **Sévérité** : 🟡 P1 — capacité backend livrée, inaccessible à l'utilisateur
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Demandeur** : audit-configui (axe config UI ↔ capacités backend)

## Résumé

Le backend VoIP expose `POST /api/voip.sync` pour forcer une synchro immédiate
des call logs (« le cron tourne aussi toutes les 15 min »). Le client front
`voip-api.ts` **n'a pas de fonction** pour cet endpoint, et le panel
`voip-panel.tsx` **n'a aucun bouton « Synchroniser maintenant »**. Le seul
levier de synchro côté utilisateur est d'attendre le cron — et encore, le cron
est gated sur `VOIP_SYNC_ENABLED='true'`, état que l'UI n'affiche nulle part.

Conséquence concrète : un client vient de connecter OVH/Telnyx et de mapper ses
numéros → il ne peut pas vérifier tout de suite que ça remonte, il doit attendre
jusqu'à 15 min (ou indéfiniment si `VOIP_SYNC_ENABLED` n'est pas set sur
l'instance). Aucun feedback « ça marche ».

## Preuve (2 bouts)

### Backend — la capacité existe

`api/src/voip/voip.controller.ts:153-167` :

```ts
@Post('voip.sync')
@HttpCode(200)
@UseGuards(WorkspaceAuthGuard)
@RequirePermission('voip.write')
@ApiOperation({
  summary:
    'Déclenche une synchro VoIP immédiate (tous credentials actifs). Le cron tourne aussi toutes les 15 min.',
})
async syncNow(@Body() _dto: { workspace_id: string }) {
  const result = await this.sync.syncAll();
  return { ok: true, ...result };
}
```

Le cron est gated, `api/src/voip/voip-sync.service.ts:43-51` :

```ts
private enabled(): boolean {
  return this.config.get<string>('VOIP_SYNC_ENABLED') === 'true';
}
@Cron('0 */15 * * * *')
async scheduledSync(): Promise<void> {
  if (!this.enabled()) return;   // ← si non set : AUCUNE synchro automatique
  await this.syncAll();
}
```

### UI — la capacité est absente

`console/src/veridian/settings-panels/voip-api.ts` expose `fetchVoipSettings`,
`saveCredential`, `testCredential`, `deleteCredential`, `fetch/create/update/
deletePhoneNumber` — **mais aucun `syncNow`**. Confirmé par grep : `voip.sync`
n'apparaît dans aucun fichier console.

`voip-panel.tsx` : la `CredentialCard` (lignes 745-811) affiche `lastSyncAt` et
`lastError` mais ne propose que « Tester la connexion » et « Supprimer ». Pas de
« Synchroniser maintenant ». Le `CallsHint` (lignes 665-694) renvoie vers
Live/Explore mais ne déclenche rien.

## Demande précise

Onglet Settings concerné : **Téléphonie / VoIP** (`section='voip'`, déjà
existant — pas de nouvelle route, conforme à la vision « tout en onglet
Settings »).

1. **Ajouter `syncNow(workspaceId)` dans `voip-api.ts`** :
   ```ts
   export function syncNow(workspaceId: string):
     Promise<{ ok: true; syncedWorkspaces: number; pushedEvents: number }> {
     return request('voip.sync', { method: 'POST', body: { workspace_id: workspaceId } });
   }
   ```

2. **Ajouter un bouton « Synchroniser maintenant »** dans `voip-panel.tsx`,
   visible dès qu'au moins un credential `status==='ok'` existe (à côté du
   `CallsHint`, ou dans la `CredentialCard`). Au retour, afficher
   `{pushedEvents} appel(s) remonté(s)` + rafraîchir (le `lastSyncAt` se met à
   jour). C'est le feedback « ça marche » manquant juste après la config.

3. **Surfacer l'état du cron** : si `VOIP_SYNC_ENABLED` n'est pas actif sur
   l'instance, la synchro auto ne tourne jamais — l'utilisateur doit le savoir.
   Soit `voip.settings` renvoie un flag `autoSyncEnabled`, soit le panel
   affiche un bandeau « Synchro automatique toutes les 15 min » vs « Synchro
   manuelle uniquement » selon l'état. (Vérifier si `VOIP_SYNC_ENABLED` est bien
   set dans le compose prod/staging au passage — sinon les appels ne remontent
   *jamais* tout seuls, ce qui rendrait le bouton manuel d'autant plus critique.)

## Impact

- Sans le bouton : pas de boucle de validation à la config. Le client ne peut
  pas confirmer que ses appels remontent sans attendre le cron (15 min) ou sans
  qu'un opérateur tape l'API en CLI.
- Si `VOIP_SYNC_ENABLED` n'est pas set en prod, la feature Calls (n°2 du scope
  commercial) est **silencieusement morte** : aucune synchro auto + aucun
  déclencheur manuel UI = zéro appel jamais ingéré. À vérifier en priorité.
- Tier 🟡 MOYEN (ajout client API + bouton UI, pas de surface auth/billing/DB).
