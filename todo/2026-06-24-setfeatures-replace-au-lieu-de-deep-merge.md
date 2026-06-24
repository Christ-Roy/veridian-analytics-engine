# setFeatures REMPLACE l'objet features au lieu de deep-merger (200 silencieux)

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Trouvé par** : probe-lifecycle (audit cycle de vie M2M, staging)

## Symptôme reproductible (staging, workspace `probe_lifecycle_test`)

Le contrat de `workspaces.setFeatures` (`analytics ui:features`) est un **deep-merge** :
poser un flag ne doit PAS effacer les autres. En réalité chaque appel **remplace
intégralement** l'objet `features`. Bug silencieux : write 200, read montre la perte.

```
$ analytics --env staging ui:features probe_lifecycle_test --off connectors,gsc,voip
  write features: {'connectors': False, 'voip': False, 'gsc': False}
$ analytics --env staging ui:get probe_lifecycle_test
  read  features: {'connectors': False, 'voip': False, 'gsc': False}   # OK persisté

$ analytics --env staging ui:features probe_lifecycle_test --on voip     # rallume voip seul
  write features: {'voip': True}                                         # gsc + connectors DISPARUS
$ analytics --env staging ui:get probe_lifecycle_test
  read  features: {'voip': True}                                         # ❌ perte silencieuse
```

Reproduit aussi à 1 flag : `--on gsc` (read `{gsc:true}`), puis `--on voip` → read `{voip:true}`,
gsc effacé. Testé avec 15 s d'attente entre les deux writes → **le replace persiste** (ce
n'est PAS une simple latence de cohérence ClickHouse).

### Preuve au niveau stockage (ClickHouse `staminads_system.workspaces`)

Après la séquence `--on gsc` puis `--on voip`, la ligne stockée contient :

```json
"features":{"voip":true}
```

Un seul flag. Pas de doublon résiduel (`GROUP BY` → `n:1`). Donc le DELETE+INSERT a bien
nettoyé : le problème n'est PAS des lignes dupliquées, c'est que le merge écrit une seule clé.
À noter : `branding` et `dashboard_layout` coexistent correctement dans la même ligne — seul
`features` est écrasé, car eux ne re-lisent pas l'état précédent avant d'écrire.

## Cause probable

`admin-platform.service.ts :: setFeatures()` fait pourtant le bon merge en mémoire :

```ts
const ws = await this.workspacesService.get(dto.workspace_id);
const merged = { ...(ws.settings.features ?? {}), ...dto.features };
await this.workspacesService.update({ id, settings: { features: merged } });
```

Le code source (commit 2c099aa, présent dans l'image staging déployée `staging-29996f5`,
vérifié `git merge-base --is-ancestor`) deep-merge. Il y a même un test unitaire vert
(`admin-platform.service.spec.ts :: 'setFeatures DEEP-merges over the existing flags'`).

**Mais le test MOCKE `workspacesService.get`** pour retourner `{features:{voip:true,gsc:true}}`.
En réel, `merged` ne contient que `dto.features` → cela signifie que `ws.settings.features`
est lu **vide `{}`** au moment du merge dans `setFeatures`, alors que `getCustomization`
(même `workspacesService.get`, appelé juste après dans la réponse) le lit plein.

Pistes à investiguer (cause racine non tranchée — c'est le job de l'agent fix) :
1. **Race DELETE/INSERT non-atomique** : `WorkspacesService.update()` fait
   `ALTER TABLE workspaces DELETE WHERE id=…` (mutation async ClickHouse) puis `INSERT`.
   Le `get()` suivant dans `setFeatures` peut lire l'état AVANT que la mutation ne soit
   visible. MAIS l'attente de 15 s ne corrige pas → soit la mutation reste invisible plus
   longtemps, soit ce n'est pas la cause.
2. **`get()` qui ne voit pas la dernière écriture** : `SELECT … ORDER BY updated_at DESC
   LIMIT 1` est censé prendre la plus récente, mais si une lecture tombe pendant la fenêtre
   DELETE+INSERT elle peut renvoyer 0 ligne (→ NotFound) ou l'ancienne. Le commentaire du
   code admet déjà cette race.
3. **Divergence subtile parse/serialize** : peu probable (round-trip JSON propre vérifié),
   mais à exclure formellement.

Le test unitaire est **trompeur** : il valide la logique de merge sur un mock, pas le
chemin réel get→merge→update→get sur ClickHouse. À renforcer par un test
d'intégration sur vraie DB (ou au minimum un mock qui simule la latence DELETE/INSERT).

## Impact

🔴 Réglage white-label perdu silencieusement. Scénario client réel :
- Un workspace a `connectors:false, gsc:false` (client sans ces options souscrites).
- Robert/l'admin rallume une seule option (`--on gsc`) → `connectors` repasse à son défaut
  (probablement visible côté console car la clé disparaît du JSON → fallback UI).
- L'admin croit n'avoir touché qu'un flag ; il en a réinitialisé d'autres. Aucune alerte,
  HTTP 200, la réponse write elle-même ment (`{gsc:true}` au lieu de l'état complet mergé).

C'est exactement le pire type de bug visé par cet audit : « répond 200 mais écrase en silence ».

## Réparation attendue (voie propre, pas de contournement)

1. **Rendre `WorkspacesService.update()` robuste à sa propre race** : soit lire l'état
   courant de façon garantie-fraîche (ex. `SELECT … FINAL` ou attendre la fin de mutation),
   soit basculer la table `workspaces` sur un moteur qui supporte l'upsert proprement
   (`ReplacingMergeTree` + `FINAL`, ou une vraie UPDATE) plutôt que DELETE+INSERT non-atomique.
2. Vérifier que le même bug ne touche pas les autres writes qui re-lisent l'état avant
   d'écrire (audit cross-check : `setCrmMapping` est full-replace donc OK ; `setBranding`/
   `setLayout` sont full-replace ; `updateSettings`/`settings` mergent au 1er niveau dans
   `update()` — à re-vérifier eux aussi, cf ticket settings deep-merge si déposé).
3. Ajouter un **test d'intégration** (pas mock) : poser 2 flags, en flipper 1, relire,
   asserter que les 2 autres survivent.

## Note adjacente (à traiter ailleurs, pas ici)

Le CLI `analytics` affiche le body d'une réponse d'erreur (`429`, `400`) comme un payload
normal, sans exit-code non-zéro clair → un agent qui scripte `ui:get | jq .features` voit
`null` sans comprendre que c'était un rate-limit. Voir si couvert par le ticket existant
`2026-06-24-m2m-cinq-formats-erreur-incoherents.md`.
