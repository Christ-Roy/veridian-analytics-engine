# Cohérence micro-patterns entre panels VoIP / Connecteurs / GSC

> **Sévérité** : 🟢 P2
> **Owner** : agent engine
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-panels (cohérence Settings)

## Contexte

Même en restant dans leur design system custom actuel, les 3 panels Veridian
**réinventent chacun de leur côté** des patterns identiques (secret write-only,
bouton Tester, carte credential/statut, empty state, toast inline, modale) avec
des variations gratuites. Ce ticket liste les divergences à harmoniser.

> ⚠️ Ce ticket devient **partiellement caduc** si
> [[2026-06-19-ui-panels-veridian-hors-design-system-antd]] est traité d'abord
> (réécriture AntD) — auquel cas l'harmonisation se fait naturellement via les
> composants AntD natifs (`message`, `Modal`, `Tag`, `Table`). À traiter
> APRÈS le ticket P1, ou à fusionner dedans. Gardé séparé pour tracer les
> divergences précises à ne pas reproduire.

## Divergences constatées

### 1. Toast / feedback de succès-erreur : 3 implémentations différentes

- **VoIP** : état inline `<p className="text-emerald-400 / text-destructive">`
  posé sous la carte (`voip-panel.tsx:901-911`, `:747-762`).
- **Connecteurs** : encart bordé `TestResultRow` avec icône + HTTP status
  (`connectors-panel.tsx:369-405`).
- **GSC** : `InlineError` rouge seulement, pas de toast succès du tout
  (`search-console-panel.tsx:524-533`).
- **Natif (référence)** : `App.useApp().message.success/error` partout
  (TeamSettings, AnnotationsSettings, api-keys).

→ **Demande** : un seul pattern de feedback. Cible = `message` AntD.

### 2. Carte de credential / statut : 2 structures

- **VoIP** `CredentialCard` (`voip-panel.tsx:801-914`) : titre + `StatusBadge`
  + boutons Tester/Supprimer + dict masqué + lastSyncAt + lastError.
- **Connecteurs** `ConnectorCard` (`connectors-panel.tsx:186-367`) : nom +
  badges (Twenty/Webhook/Actif/Simulation) + url + events + barre de 5 boutons.
- **GSC** : pas de carte, un bloc `bg-emerald-400/5` inline
  (`search-console-panel.tsx:194-243`).

→ Trois mises en page pour « voici une intégration connectée + ses actions ».
**Demande** : structure commune (en-tête nom+statut, ligne méta, rangée
d'actions identique).

### 3. Empty state : 2 styles, libellés différents

- **VoIP** `EmptyTrackedNumbers` (`voip-panel.tsx:390-413`) : `border-dashed` +
  texte + bouton `outline` « Ajouter votre premier numéro ».
- **Connecteurs** `EmptyConnectors` (`connectors-panel.tsx:826-849`) :
  `border-dashed` + texte + bouton `outline` « Connecter votre CRM Twenty ».
- **GSC** : pas d'empty state dédié, juste le CTA OAuth.
- **Natif** : `<Empty image={Empty.PRESENTED_IMAGE_SIMPLE}>` (TeamSettings,
  AnnotationsSettings, api-keys).

→ **Demande** : `<Empty>` AntD pour tous, ou à défaut un composant empty-state
partagé unique.

### 4. Bouton « Tester » : libellés et icônes incohérents

- **VoIP** : « Tester la connexion » + icône `RefreshCw`
  (`voip-panel.tsx:871`).
- **Connecteurs** : « Tester » (tout court) + icône `RefreshCw`
  (`connectors-panel.tsx:297`).

→ **Demande** : libellé unique (« Tester la connexion »).

### 5. Secret write-only : 2 messages d'aide différents

- **VoIP** : « Vos identifiants sont chiffrés (AES-256-GCM) avant stockage. Ils
  ne sont jamais réaffichés en clair. » (`voip-panel.tsx:985-988`).
- **Connecteurs** : « Votre clé est chiffrée (AES-256-GCM) avant stockage et
  n'est jamais réaffichée en clair. » (`connectors-panel.tsx:744`).

→ Quasi identiques mais pas synchronisés. **Demande** : un texte canonique
unique (constante partagée).

### 6. Modale : overlay + largeur custom divergents

- **VoIP** `PhoneNumberModal` : `max-w-md`, overlay `bg-black/60`
  (`voip-panel.tsx:553-560`).
- **Connecteurs** `ConnectorModal` : `max-w-lg`, overlay `bg-black/60`
  (`connectors-panel.tsx:660-667`).

→ Deux largeurs, overlay réimplémenté. **Demande** : `<Modal>` AntD (largeur
via prop `width`, overlay et focus-trap gérés nativement — gain a11y au
passage).

### 7. Composant `Section` dupliqué 3×

Fonction `Section` (icône carrée teal + titre + description) copiée-collée à
l'identique dans les 3 panels (`voip-panel.tsx:995`, `connectors-panel.tsx:853`,
`search-console-panel.tsx:488`). + `InlineError`, `PanelError`, `formatDate`
dupliqués pareil.

→ **Demande** : factoriser dans `veridian/settings-panels/_shared.tsx` (ou
mieux : supprimer au profit du chrome AntD natif lors de la réécriture P1).

## Impact

Modéré. Pas de bug, mais incohérences qui se voient à l'œil quand on navigue
entre les 3 onglets, et code dupliqué qui dérive (déjà 2 textes « chiffré »
désynchronisés, 2 libellés « Tester »).

## Demande synthétique

Si le P1 (réécriture AntD) est fait → ces points tombent presque tous. Sinon,
a minima : factoriser `Section`/`InlineError`/`PanelError`/`formatDate` +
unifier toasts, empty states, libellés, et le texte « chiffré ».
