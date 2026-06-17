# 🟡 Webhooks / connecteur Twenty : module backend complet, zéro config UI (onglet Settings manquant)

> **Sévérité** : 🟡 P1 — capacité métier livrée et prouvée E2E, pilotable uniquement par API/CLI
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Demandeur** : audit-configui (axe config UI ↔ capacités backend)

## Résumé

Le module `webhooks` de l'engine est **complet** : CRUD destinations, test,
liste/retry des deliveries, catalogue d'événements, et surtout le **connecteur
Twenty natif** (`transform.type='twenty'`, push score + timeline vers le CRM
client), livré en prod et prouvé data-nickel (cf mémoires
`project_twenty_connector_native_proven` et
`project_tunnel_connecteur_twenty_natif_design_b`).

Mais **aucune surface de configuration UI** : la console n'a pas d'onglet
Settings « Webhooks » / « Connecteurs ». L'unique onglet « Intégrations »
(`integrations`) ne gère QUE l'API key Anthropic de l'assistant IA. Pour brancher
un client analytics → son Twenty, il faut taper l'API M2M en CLI/script (c'est
exactement ce que décrit le ticket `2026-06-14-brancher-connecteur-twenty-
workspace-reel.md` : provision clé + `webhooks.create` à la main).

## Preuve (2 bouts)

### Backend — module complet

`api/src/webhooks/webhooks.controller.ts:46-220` :

```
POST  webhooks.create          GET  webhooks.list        GET webhooks.get
POST  webhooks.update          POST webhooks.delete      POST webhooks.test
GET   webhooks.deliveries.list POST webhooks.deliveries.retry
GET   webhooks.events
```

Le connecteur Twenty est un type de destination de premier plan,
`api/src/webhooks/entities/webhook-definition.entity.ts:31-37,62-70` :

```
// The webhook `url` is the Twenty REST base URL, `auth.token` (encrypted) is
// the Twenty Bearer. The connector batches timeline activities + resolves the
// person... Cf CONTRATS-TUNNEL §4c + connectors/twenty-connector.service.ts.
type: 'twenty';
...
name: string; url: string; active: boolean;
auth_secret_encrypted: string; events: string[]; transform: WebhookTransform;
```

### UI — capacité absente

- Liste des onglets Settings :
  `console/src/routes/_authenticated/workspaces/$workspaceId/settings.tsx:25`
  → `['workspace', 'dimensions', 'team', 'integrations', 'smtp', 'api-keys',
  'privacy', 'sdk', 'voip', 'search-console', 'danger']` — **pas de `webhooks`**.
- Grep `webhook` sur tout `console/src/` → **zéro composant** (seul hit :
  un commentaire dans `welcome.tsx:82`, faux positif).
- L'onglet `integrations` =
  `console/src/components/settings/IntegrationsSettings.tsx` → gère uniquement
  `type === 'anthropic'` (clé API + modèle Claude). Rien sur les webhooks/Twenty.

## Demande précise

Onglet Settings concerné : **nouvel onglet « Connecteurs »** (ou enrichir
`integrations`), conforme à la vision « extensions Veridian = onglets Settings
uniquement, pas de page dédiée ». Étendre le `z.enum section` avec
`'connectors'` (ou réutiliser `'integrations'`).

Le panel doit permettre de :
1. **Lister** les webhooks/connecteurs du workspace (`webhooks.list`), avec
   statut active/inactive + dernier statut de delivery.
2. **Créer un connecteur Twenty** : champ URL REST Twenty + Bearer (chiffré
   côté backend, masqué comme les creds VoIP), sélection des événements
   (`webhooks.events` → `screen_view` / `goal`), toggle `dry_run`.
3. **Tester** (`webhooks.test`) et afficher le résultat.
4. **Voir les deliveries** récentes (`webhooks.deliveries.list`) + bouton retry
   (`webhooks.deliveries.retry`) sur les échecs.
5. Activer / désactiver / supprimer.

Réutiliser les primitives du `voip-panel.tsx` (CredentialCard masquée, test,
statut) pour la cohérence visuelle et le pattern « secret chiffré jamais
réaffiché ».

## Lien avec le ticket existant

Distinct du ticket `2026-06-14-brancher-connecteur-twenty-workspace-reel.md` :
celui-ci est l'**activation opérationnelle one-shot** par Robert (créer LE
webhook du vrai workspace commercial via API M2M). Le présent ticket adresse la
**self-config par le client** depuis la console — nécessaire pour le
mass-onboarding / commercialisation, où chaque client branche son propre CRM
sans intervention CLI de Robert. Les deux sont complémentaires.

## Impact

- Sans onglet : impossible pour un client (ou pour Robert en libre-service) de
  brancher un Twenty sur un workspace sans script CLI. Bloque la promesse
  « tunnel analytics → CRM » en self-service.
- Le connecteur Twenty est une capacité prouvée et en prod — la laisser sans UI
  = feature payante invisible/inopérable côté client.
- Tier 🟡 MOYEN à 🔴 HAUT (manipule un secret chiffré Bearer Twenty → traiter le
  champ secret comme tier auth : write-only, masqué, jamais renvoyé en clair).
