# Menu Settings : icônes seulement sur onglets Veridian + détails FR

> **Sévérité** : 🔵 P3
> **Owner** : agent engine
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-panels (cohérence Settings)

## Constat

### 1. Icônes incohérentes dans le menu Settings

Dans `console/src/routes/_authenticated/workspaces/$workspaceId/settings.tsx`
(`menuItems`, `:77-90`), **seuls les 3 onglets Veridian** ont une icône :

- `voip` → `PhoneCall`, `search-console` → `SearchIcon`, `connectors` → `Plug`
  (lucide-react).
- Tous les onglets natifs (Espace de travail, Dimensions, Équipe,
  Intégrations, Email SMTP, Clés API, Confidentialité, Installer le SDK, Zone
  dangereuse) → **aucune icône**.

Rendu (`:699-711`) : la sidebar affiche 9 entrées texte nu, puis 3 entrées
texte + icône, puis 1 nue. Les 3 features Veridian se **distinguent
visuellement** du reste du menu — exactement ce qu'on ne veut pas (elles
doivent se fondre, pas ressortir).

→ **Demande** : soit ajouter une icône cohérente à TOUS les items du menu
(lucide-react, taille 14, comme les 3 existants), soit retirer les icônes des
3 Veridian pour aligner sur le reste. Le plus propre = icônes partout
(meilleure lisibilité), mais le minimum acceptable = pas de traitement
différencié. Trancher avec Robert si doute, défaut recommandé : **icônes
partout**.

### 2. Ordre des onglets — features Veridian dispersées vs groupées

Ordre actuel : workspace, dimensions, team, integrations, smtp, api-keys,
privacy, sdk, **voip, search-console, connectors**, danger.

Les 3 onglets Veridian sont déjà groupés en fin (avant `danger`), ce qui est
correct. RAS sur l'ordre — juste noter qu'`integrations` (Anthropic) est loin
des 3 autres intégrations Veridian (voip/connectors), alors que ce sont
conceptuellement toutes des « intégrations ». Optionnel : envisager un
regroupement « Intégrations » (Anthropic + VoIP + Connecteurs + Search Console)
si Robert veut une IA d'archi par familles. **Non bloquant, pas demandé** —
laissé en note.

### 3. Détails FR / libellés

- **`StatusBadge` VoIP** (`voip-panel.tsx:1031-1037`) : « Connexion OK » mêle
  FR + anglicisme « OK » (toléré) ; « Non testé » / « Échec » OK. Cohérent
  avec l'esprit FR. RAS bloquant.
- **`EVENT_LABELS` connecteurs** (`connectors-panel.tsx:60-64`) : « Page vue
  (screen_view) », « Objectif atteint (goal) » — affichent le nom technique
  EN entre parenthèses. Acceptable (transparence technique) mais à valider :
  un client FR non-technique n'a pas besoin de voir `screen_view`. Option :
  retirer la parenthèse technique pour les non-admins. **Non bloquant.**
- **Cohérence « synchro »** : VoIP dit « Synchroniser maintenant » / « Synchro
  automatique » / « Dernière synchro » (`voip-panel.tsx:745,773,895`) ; GSC dit
  « Resynchroniser maintenant » / « première synchronisation »
  (`search-console-panel.tsx:225,352`). Deux verbes (« Synchroniser » vs
  « Resynchroniser ») pour la même action de refresh manuel. → **Demande** :
  harmoniser sur un seul (« Synchroniser maintenant » partout, ou
  « Resynchroniser » partout).

## Impact

Faible (cosmétique). Le point #1 (icônes différenciées) est le plus visible :
il fait ressortir les features Veridian dans le menu au lieu de les fondre.

## Demande synthétique

1. Icônes : traitement uniforme du menu Settings (recommandé : icône partout).
2. Verbe de synchro unique entre VoIP et GSC.
3. (#2 ordre et #3 EVENT_LABELS : notes, à arbitrer avec Robert, non bloquant.)
