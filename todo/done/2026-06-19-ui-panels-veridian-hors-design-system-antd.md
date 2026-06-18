# Panels Veridian (VoIP / Connecteurs / GSC) hors design system AntD — îlots dark/teal

> **Sévérité** : 🟡 P1
> **Owner** : agent engine
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-panels (cohérence Settings)

## TL;DR

Les 3 panels Veridian (`voip-panel.tsx`, `connectors-panel.tsx`,
`search-console-panel.tsx`) sont écrits dans un **design system parallèle**
(shadcn/ui porté du legacy + palette **dark** + primaire **teal/cyan**)
totalement étranger au design system réel de la console engine (**Ant Design
v6** + fond **clair** + primaire **violet `#7763F1`**).

Résultat visuel : quand l'utilisateur clique sur l'onglet Settings →
« Téléphonie », « Search Console » ou « Connecteurs », il passe d'une page
blanche AntD à une **grande carte noire à accents cyan**. C'est l'exact
contraire de la consigne Robert : *« tout doit se fondre dans le natif
staminads, sans dénoter »* et *« les features Veridian doivent être proprement
mises dans l'UI de base »* (CLAUDE.md, VISION 2026-05-23). Ces panels
**dénotent au maximum**.

C'est l'incohérence #1 de l'audit. Tous les autres tickets UI de cette salve
en découlent.

## Constat — mesuré contre le design system réel

### Le design system réel (ce contre quoi on mesure)

- **AntD v6.1.2** + `@ant-design/icons` v6.1.0 (`console/package.json`).
- Primaire **`#7763F1`** (violet) : `console/src/main.tsx:30` (`colorPrimary`
  + `colorLink`) et `console/src/index.css:6` (`--primary: #7763f1`).
- Background **`rgb(243,246,252)`** (clair bleuté), foreground `#171717`
  (`console/src/index.css:4-5`).
- `Card.borderRadius: 4` (coins quasi droits), `Table` header transparent
  fontSize 12 (`main.tsx:33-46`).
- **Tous** les autres panels Settings sont 100 % AntD + `bg-white` :
  - `settings.tsx` (workspace, dimensions, privacy, danger) → `Form`, `Input`,
    `Select`, `Table`, `Tag`, `Switch`, `Modal`, `message`, `bg-white p-6
    rounded-lg shadow-sm`.
  - `components/settings/IntegrationsSettings.tsx` → `Form`, `Input.Password`,
    `AutoComplete`, `Switch`, `Popconfirm`, `message`, `bg-white`.
  - `components/settings/TeamSettings.tsx` → `Table`, `Tag`, `Select`,
    `Space`, `Popconfirm`, `Empty`, `Avatar`, `Typography`, `message`.
  - `components/settings/AnnotationsSettings.tsx` → `Modal`, `Form`, `Table`,
    `Popconfirm`, `Empty`, `message`.
  - `pages/settings/api-keys.tsx`, `pages/settings/smtp.tsx` → idem AntD pur.

### Les 3 panels Veridian (ce qui dénote)

- Importent un DS custom : `console/src/veridian/ui/card.tsx`,
  `ui/button.tsx`, `ui/badge.tsx` — **ports shadcn/ui** du legacy (commentaire
  explicite `card.tsx:5` *« port direct depuis veridian-analytics legacy »*).
- Tout est wrappé dans `.veridian-scope` (`voip-panel.tsx:159`,
  `connectors-panel.tsx:121`, `search-console-panel.tsx:89`) qui **redéfinit
  localement** les tokens via `console/src/veridian/theme.css` :
  - `--background: 224 24% 6%` → **quasi noir** (theme.css:20)
  - `--card: 222 20% 9%` → carte noire (theme.css:24)
  - `--primary: 174 72% 56%` → **teal/cyan**, PAS le violet `#7763F1`
    (theme.css:29) ; le commentaire l'assume : *« primary plus saturé
    (cyan/teal Veridian) »* (theme.css:14, 27-28)
  - `--radius: 0.75rem` → 12 px d'arrondi vs 4 px AntD (theme.css:53)
  - font `Inter` forcée (theme.css:58)
- Conséquence : les classes `bg-card`, `text-muted-foreground`,
  `border-border`, `bg-primary`, `text-primary` utilisées partout dans les 3
  panels rendent en **noir/teal**, pas en blanc/violet.

### Primitives HTML brutes au lieu d'AntD

Les panels n'utilisent pas seulement le mauvais thème : ils réimplémentent à
la main des composants qu'AntD fournit nativement.

| Besoin | Natif AntD (utilisé partout ailleurs) | Panels Veridian |
|---|---|---|
| Liste de données | `<Table>` | `<table>` HTML brut (`voip-panel.tsx:429`, `connectors-panel.tsx:482`) |
| Modale | `<Modal>` | `<div className="fixed inset-0 … bg-black/60">` (`voip-panel.tsx:555`, `connectors-panel.tsx:662`) |
| Select | `<Select>` | `<select>` HTML brut (`voip-panel.tsx:223,606`, `search-console-panel.tsx:411`) |
| Input | `<Input>` / `<Input.Password>` | `<input type="password">` brut (`voip-panel.tsx:962`, `connectors-panel.tsx:728`) |
| Onglets | `<Tabs>` | `<button>` + état custom (`search-console-panel.tsx:457-475`) |
| Toast succès/erreur | `message.success/error` (App.useApp) | état inline `<p className="text-emerald-400">` (`voip-panel.tsx:901`, `connectors-panel.tsx:344`) |
| Bouton | `<Button type="primary">` | `<Button>` shadcn custom (`ui/button.tsx`) |

## Impact

- **Visuel** : rupture brutale clair→sombre + violet→teal à chaque onglet
  feature Veridian. L'app paraît « bricolée », pas premium. C'est exactement ce
  que Robert veut éviter (*« l'UI doit être parfaite, harmonieuse »*).
- **Accessibilité** : le thème dark teal n'a jamais été contrôlé pour le
  contraste sur fond clair (les `bg-black/60` overlays, les `text-emerald-300`
  sur fond noir cassent si le scope dark ne s'applique pas comme prévu).
- **Maintenance** : 2 design systems à maintenir, 2 jeux de primitives, 2
  conventions de toast/modale/table. Tout nouveau panel doit choisir — et le
  dernier en date (`connectors`, 2026-06-17) a copié le mauvais.
- **i18n/format** : les toasts inline custom échappent au système `message`
  AntD (placement, durée, locale frFR cohérents ailleurs).

## Demande précise (réécriture vers AntD natif)

L'objectif : **les 3 panels rendent en AntD pur, fond clair, primaire violet,
exactement comme TeamSettings / AnnotationsSettings / api-keys**. On garde la
logique métier (appels API, états, write-only secret), on remplace **la couche
de présentation**.

1. **Supprimer le scope dark** : retirer `import '../theme.css'` et le wrapper
   `className="veridian-scope"` des 3 panels. Plus aucun token dark/teal en
   jeu — on hérite du thème AntD clair de la console.
2. **Remplacer les primitives custom par AntD** :
   - `Card`/`CardContent` shadcn → `<Card>` AntD (ou simple `bg-white p-6
     rounded-lg shadow-sm` comme les autres panels).
   - `<table>` → `<Table>` AntD (colonnes typées, `size`, responsive mobile via
     pattern card comme TeamSettings).
   - overlay modal custom → `<Modal>` AntD (`onOk`/`onCancel`/`confirmLoading`).
   - `<select>`/`<input>` → `<Select>`/`<Input>`/`<Input.Password>` AntD dans
     des `<Form.Item>`.
   - onglets query/page GSC → `<Tabs>` AntD.
   - toasts inline → `App.useApp().message.success/error`.
   - badges custom → `<Tag>` AntD (cf. mapping couleurs ci-dessous, ticket
     [[2026-06-19-ui-coherence-micro-patterns-panels]]).
3. **Boutons** : `<Button type="primary">` pour l'action principale (Connecter,
   Enregistrer, Ajouter), `<Button>` (default) pour secondaire, `danger` pour
   suppression — au lieu des variants shadcn `default/outline/ghost`.
4. **Icônes de feature** (Phone, Search, Plug en tête de section) : OK de garder
   `lucide-react` (déjà utilisé dans le menu Settings `settings.tsx:6`), mais
   sans le carré teal `bg-primary/10 text-primary` — un titre AntD `Typography`
   simple suffit, comme AnnotationsSettings.
5. **Une fois fait** : `console/src/veridian/ui/` (card/button/badge) et
   `console/src/veridian/theme.css` deviennent du **code mort** si plus aucun
   composant non-archivé ne les importe → vérifier puis supprimer (ticket de
   suivi à créer si des composants `_optional-features/` / `_archive/` les
   utilisent encore — dans ce cas garder mais ne plus s'en servir dans les
   panels live).

## Ampleur / découpage suggéré

Gros morceau (~3 fichiers de 600-1100 lignes à réécrire côté présentation).
Découper en 3 sous-chantiers indépendants, un sous-agent par panel, avec un
**panel de référence imposé** pour garantir la convergence :

- **VoIP** (`voip-panel.tsx`, 1102 l.) → référence `TeamSettings.tsx` (table +
  modale + form).
- **Connecteurs** (`connectors-panel.tsx`, 960 l.) → référence `api-keys.tsx`
  (liste de credentials + secret write-only + modale création).
- **Search Console** (`search-console-panel.tsx`, 612 l. + module `gsc/`) →
  référence `AnnotationsSettings.tsx` pour le chrome + garder les charts
  (`gsc/time-series-chart.tsx`, `gsc/data-table.tsx`) — vérifier que ces
  sous-composants ne dépendent pas eux-mêmes du scope dark.

Avant de lancer : vérifier que `gsc/kpi-tile.tsx`, `gsc/data-table.tsx`,
`gsc/time-series-chart.tsx`, `gsc/performance-dashboard.tsx`, `sparkline.tsx`
ne sont pas eux aussi en dark/shadcn (probablement si, vu qu'ils nourrissent le
panel GSC) — élargir le scope du sous-chantier GSC en conséquence.

## Note pour l'agent de fix

Ne PAS recréer une sous-route ni une page dédiée (VISION 2026-05-23 : extensions
= onglets Settings only). On reste strictement dans le rendu des 3 sections
existantes. Aucun changement de logique API, juste la couche UI. Tester le rendu
sur staging (`analytics-engine.app.veridian.site` ou équivalent) AVANT promo —
le but est précisément visuel.
