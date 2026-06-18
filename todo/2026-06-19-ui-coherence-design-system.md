# Cohérence du design system — tokens, thème, typo, dark mode

> **Sévérité** : 🟡 P1 (incohérence visible #1) + findings 🟢 P2 groupés
> **Owner** : agent veridian-analytics (engine)
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-designsystem (axe cohérence transverse)

## TL;DR — les 3 ruptures à corriger en priorité

1. **Deux identités de marque coexistent** : staminads natif = **violet
   `#7763f1` en thème CLAIR** ; tout le code Veridian = **teal `174 72% 56%`
   en faux dark mode** (`.veridian-scope`). Résultat : en cliquant sur l'onglet
   Settings « Search Console » / « VoIP » / « Connecteurs », l'app bascule
   d'un bloc clair violet à un bloc sombre teal — rupture brutale dans la
   MÊME page. C'est le défaut de cohérence n°1.
2. **Double `ConfigProvider` AntDesign** avec primaire dupliquée et casse
   divergente (`#7763F1` vs `#7763f1`). Le second est inutile et trompeur.
3. **Typographie micro non systématisée** : `text-[11px]` / `[10px]` / `[9px]`
   en dur ~60 fois, aucune échelle nommée.

---

## 1. 🟡 Conflit des deux `ConfigProvider` (réponse au point signalé)

**Verdict : ce ne sont PAS deux thèmes qui s'affrontent — le second est
redondant et incomplet, mais inoffensif au rendu. À supprimer pour la clarté.**

- `console/src/main.tsx:28-47` + `:63` → `ConfigProvider` **racine** réel, qui
  porte tout le thème (`colorPrimary:'#7763F1'`, `colorLink`, overrides Card +
  Table) **et** `locale={frFR}`. C'est lui qui gouverne.
- `console/src/routes/__root.tsx:12-18` → un **second** `ConfigProvider`
  imbriqué qui ne redéfinit QUE `colorPrimary:'#7763f1'`.

Qui gagne ? AntDesign fusionne les `ConfigProvider` imbriqués ; les tokens non
redéfinis par l'enfant sont **hérités** du parent. Donc :
- `colorPrimary` : enfant `#7763f1` = parent `#7763F1` à la casse près → hex
  identique, **aucun effet visible**.
- tout le reste (colorLink, Card, Table, locale frFR) vient du parent.

→ Le second `ConfigProvider` **ne sert à rien** : il réaffirme une valeur déjà
posée. Il crée juste de la confusion (« lequel fait foi ? ») et un risque de
divergence future (si quelqu'un modifie l'un sans l'autre). 

**Fix** : supprimer le `ConfigProvider` de `__root.tsx`, ne garder que le
`<div className="flex min-h-screen flex-col">` + DemoBanner/Outlet/DemoFooter.
Le thème reste 100 % piloté par `main.tsx`.

| Fichier:ligne | Problème | Fix |
|---|---|---|
| `routes/__root.tsx:12-18` | `ConfigProvider` redondant, primaire dupliquée | Supprimer le wrapper, garder le layout flex |
| `main.tsx:30-31` vs `__root.tsx:15` | `#7763F1` vs `#7763f1` (casse) | N'avoir qu'UNE source = `main.tsx` |

---

## 2. 🟡 Primaire en dur dispersée — une seule source de vérité

La couleur de marque `#7763f1` est **réécrite à la main dans 8+ endroits** au
lieu d'être lue depuis un token unique. Chaque copie est une dérive potentielle.

| Fichier:ligne | Valeur | Token cible |
|---|---|---|
| `console/src/main.tsx:30` | `colorPrimary:'#7763F1'` | source de vérité (OK ici) |
| `console/src/main.tsx:31` | `colorLink:'#7763F1'` | idem |
| `console/src/index.css:6` | `--primary: #7763f1` | source CSS (OK, mais aligner casse) |
| `console/src/routes/__root.tsx:15` | `colorPrimary:'#7763f1'` | **supprimer** (cf §1) |
| `console/src/veridian/error-pages.tsx:25` | `const PRIMARY='#7763f1'` | `var(--primary)` |
| `console/src/components/goals/GoalCard.tsx:46` | `PRIMARY_COLOR='#7763f1'` | `var(--primary)` (ECharts : lire la CSS var au runtime) |
| `console/src/components/dashboard/CountryMapView.tsx:90` | `areaColor:'#7763f1'` | idem |
| `console/src/components/explore/ExploreSummary.tsx:233` | fallback `'#7763f1'` | idem |
| `console/src/components/dashboard/TrafficHeatmapWidget.tsx:199` | `borderColor:'#7763f1'` | idem |

> **Recommandation pragmatique** : pour les libellés ECharts (canvas, pas de
> CSS), garder une **constante unique exportée** (`export const BRAND_PRIMARY =
> '#7763f1'` dans un `console/src/lib/theme-tokens.ts`) plutôt que 6 copies. Le
> CSS/Tailwind lit `var(--primary)`, ECharts importe la constante. Une valeur,
> deux consommateurs, zéro dérive.

---

## 3. 🔴 (cohérence) Le faux dark mode `.veridian-scope` casse l'harmonie

**C'est la cause racine de la rupture visuelle n°1.**

- `console/src/veridian/theme.css:18-81` définit `.veridian-scope` avec une
  palette **dark hardcodée** (`--background: 224 24% 6%`, `--primary: 174 72%
  56%` teal) + `@theme inline` qui mappe `bg-card`, `text-muted-foreground`,
  etc. vers ces couleurs sombres.
- Ce scope est appliqué par **tous** les panels Settings actifs :
  - `console/src/veridian/settings-panels/search-console-panel.tsx:88-89`
  - `console/src/veridian/settings-panels/voip-panel.tsx:159`
  - `console/src/veridian/settings-panels/connectors-panel.tsx:121`
  - `console/src/veridian/pages/welcome.tsx:208`
- **MAIS** l'app native est en thème CLAIR : `routes/.../settings.tsx` rend
  `bg-white` (`:300,:476,:572,:637`), `text-gray-XXX`, nav active
  `bg-[var(--primary)]` violet (`:706`). Les onglets natifs (Espace de travail,
  Dimensions, Confidentialité, Zone dangereuse) sont clairs/violets.

→ **Cliquer sur VoIP / Search Console / Connecteurs = passer d'un panneau blanc
violet à un panneau noir teal, dans la même page Settings.** C'est l'incohérence
la plus visible de toute la surface Veridian.

Aggravant : ces panels n'utilisent QUE les primitives shadcn portées
(`ui/button`, `ui/card`, `ui/badge` — primaire teal) et JAMAIS AntDesign. Donc
ils forment un îlot cohérent *entre eux* mais étranger à l'app hôte.

### Décision à prendre (arbitrage Robert)

Deux voies, pas de demi-mesure :

- **Option A (recommandée ~75 %) — aligner les panels sur le thème clair
  staminads.** Retirer `.veridian-scope` des 3 panels Settings + welcome,
  reconstruire en composants AntDesign natifs (Card, Button, Table, Tag) comme
  le reste de Settings. Les panels deviennent invisibles en tant que « custom »
  → exactement la vision « les features Veridian vivent dans l'UI de base, pas
  dans des pages à part » (CLAUDE.md, figé 2026-05-23). Coût : réécriture UI des
  3 panels (logique/API inchangées). Bénéfice : cohérence totale, suppression de
  `theme.css` + des primitives shadcn portées (dette en moins).
- **Option B — vrai dark mode global.** Activer `theme.darkAlgorithm`
  AntDesign + tokens dark sur TOUTE l'app, pas juste les panels. Gros chantier,
  hors scope V1, et staminads upstream n'est pas pensé pour. À écarter.

**Reco : Option A.** Le `.veridian-scope` dark teal est un vestige du sprint
« composants Veridian custom » que la vision 2026-05-23 a justement débranché
(score/shadow/locked → `_optional-features/`). Les panels Settings sont les
derniers à le porter encore. Les aligner sur AntDesign clair finit le travail.

> Note : si Option A retenue, `console/src/veridian/ui/{button,card,badge}.tsx`
> (port shadcn), `theme.css`, et les animations `veridian-*` deviennent du code
> mort à supprimer. Idem pour les couleurs data-viz GSC ad-hoc (cf §5).

---

## 4. 🟢 Typographie : échelle micro non systématisée

Aucune échelle nommée. Les tailles sub-`sm` sont écrites à la main en pixels :

| Valeur | Occurrences (veridian/, hors archive) | Où |
|---|---|---|
| `text-[11px]` | 42 | partout (panels, gsc, welcome…) |
| `text-[10px]` | 16 | data-table, kpi-tile, dashboard |
| `text-[9px]` | 2 | dashboard.tsx, push-tab |
| `text-[12px]` | 2 | gsc-tab |

Le thème AntDesign Table fixe `fontSize:12` (`main.tsx:44`) mais les composants
Tailwind l'ignorent et redéfinissent `[11px]`/`[10px]`. Deux barèmes parallèles.

**Fix** : définir une échelle dans `theme.css` (ou tokens Tailwind v4) — ex
`--text-micro: 0.6875rem (11px)`, `--text-nano: 0.625rem (10px)` — et remplacer
les valeurs arbitraires. Si Option A §3 retenue, la plupart disparaissent avec
la réécriture AntDesign (Typography gère l'échelle). **Priorité basse**, à
traiter en même temps que §3.

---

## 5. 🟢 Couleurs en dur résiduelles (data-viz + UI)

Hors primaire (§2), quelques couleurs codées en dur. La plupart sont des
couleurs sémantiques de data-viz **légitimes** (charts ECharts/SVG ne peuvent
pas lire les classes Tailwind), mais elles forment une palette ad-hoc sans
token nommé, et n'incluent jamais la primaire de marque.

| Fichier:ligne | Valeur | Nature / token cible |
|---|---|---|
| `veridian/gsc/types.ts:86` | `#3b82f6` (clics) | data-viz → centraliser palette charts |
| `veridian/gsc/types.ts:91` | `#8b5cf6` (impressions) | idem |
| `veridian/gsc/types.ts:96` | `#10b981` (CTR) | idem |
| `veridian/gsc/types.ts:101` | `#f59e0b` (position) | idem |
| `veridian/sparkline.tsx:55` | `#34d399` / `#fb7185` | data-viz pos/neg → tokens success/destructive |
| `veridian/demo-banner.tsx:26` | gradient `#1d4ed8→#3b82f6` | bandeau démo (cosmétique, OK isolé) |
| `veridian/demo-footer.tsx:21,28,37` | `text-slate-300/600`, `bg-slate-900` | footer démo → tokens muted/border |
| `veridian/settings-panels/voip-panel.tsx:63` | `border-zinc-400/40 …` | statut « other » → token muted |

**Fix** : regrouper les couleurs de charts dans un `CHART_PALETTE` exporté
(même fichier que `BRAND_PRIMARY`, cf §2). Les `text-slate-*`/`zinc-*` →
remplacer par les tokens sémantiques. **Priorité basse.**

---

## 6. 🟢 Accessibilité — quelques manques ciblés

- **Contraste faible** : `text-muted-foreground/60` (×14), `/50` (×2), `/40`
  (×1) — du gris déjà clair (`215 16% 65%`) encore atténué par opacité. Sur le
  fond dark du scope, le ratio passe sous WCAG AA (4.5:1) pour du texte. Les
  pires : `veridian/pages/welcome.tsx:427,430` (`/50`),
  `veridian/_optional-features/dashboard.tsx:231` (`/40`, archivé donc mineur).
  → Plancher à `text-muted-foreground/70` minimum pour tout texte lisible.
  Se résout aussi avec Option A (passage au thème clair AntDesign conforme).
- **`aria-label` absents** : `search-console-panel.tsx` = **0 aria-label** sur
  ses boutons icônes (RefreshCw resync, Trash2 déconnexion). voip-panel (4) et
  connectors-panel (3) en ont quelques-uns mais pas systématiques.
  → Ajouter `aria-label` sur tout bouton icon-only (« Resynchroniser »,
  « Déconnecter Search Console », etc.).

---

## 7. 🟢 Pattern d'états (loading/empty/error) dédoublé

Deux systèmes coexistent :
- **AntDesign natif** : `<Spin>`, `<Empty>` (utilisés dans `settings.tsx`,
  `components/`).
- **Veridian custom** : `PanelSkeleton` + classe `.veridian-skeleton`
  (shimmer maison) dans les 3 panels Settings (`search-console-panel.tsx`,
  `voip-panel.tsx`, `connectors-panel.tsx`).

Pas de pattern unique → un loading shimmer teal sombre à côté d'un `Spin`
violet selon l'onglet. Se résout avec Option A (tout repasse en `Spin`/`Skeleton`
AntDesign). **Priorité basse, dépend de §3.**

---

## Ordre d'attaque recommandé

1. **§1** (supprimer le 2ᵉ ConfigProvider) — quick-win 2 min, zéro risque.
2. **Arbitrage Robert sur §3** (Option A vs statu quo) — c'est LA décision qui
   débloque la cohérence. Tant qu'elle n'est pas prise, §4/§5/§6/§7 sont en
   suspens car ils se résolvent en grande partie avec la réécriture AntDesign.
3. Si A validée : réécrire les 3 panels en AntDesign clair, supprimer
   `theme.css` + primitives shadcn + couleurs ad-hoc, ajouter les `aria-label`.
4. **§2** (centraliser `BRAND_PRIMARY`/`CHART_PALETTE`) — indépendant, faisable
   à tout moment.
