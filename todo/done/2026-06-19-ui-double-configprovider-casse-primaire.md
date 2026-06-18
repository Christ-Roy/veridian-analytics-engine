# Double ConfigProvider AntD + primaire définie 4× avec casses divergentes

> **Sévérité** : 🔵 P3
> **Owner** : agent engine
> **Créé** : 2026-06-19
> **Découvert par** : audit-ui-panels (cohérence Settings)

## Constat

La couleur primaire `#7763F1` est déclarée à **4 endroits**, dont 2
`ConfigProvider` AntD imbriqués avec une config partiellement divergente :

1. `console/src/main.tsx:28-47` — `ConfigProvider` racine :
   `colorPrimary: '#7763F1'` **+ `colorLink: '#7763F1'`** + theme `components`
   (Card/Table).
2. `console/src/routes/__root.tsx:12-18` — **2e `ConfigProvider`** imbriqué
   dans le 1er : `colorPrimary: '#7763f1'` (**casse minuscule**, et **sans**
   `colorLink` ni `components`).
3. `console/src/index.css:6` — `--primary: #7763f1` (CSS var, minuscule).
4. `console/src/veridian/theme.css:29` — `--primary: 174 72% 56%` → une **autre
   couleur** (teal), scopée `.veridian-scope` (cf. ticket
   [[2026-06-19-ui-panels-veridian-hors-design-system-antd]]).

### Pourquoi c'est un problème

- **Le 2e `ConfigProvider` dans `__root.tsx` est redondant et appauvrit le
  thème** : étant imbriqué sous celui de `main.tsx`, AntD v6 fusionne mais le
  plus profond peut **écraser** `colorLink` et les overrides `components`
  (Card/Table) absents de `__root.tsx`. Selon l'ordre de résolution, les liens
  (`colorLink`) et le styling Card/Table peuvent ne pas s'appliquer comme prévu
  sous l'arbre de routes. Un seul ConfigProvider, source unique, élimine
  l'ambiguïté.
- **Casse `#7763F1` vs `#7763f1`** : sans impact CSS (hex insensible à la
  casse) mais c'est un signal de copier-coller non synchronisé. Une seule
  graphie.
- **4 déclarations = 4 endroits à changer** si Robert veut ajuster la teinte.

## Impact

Faible (cosmétique / hygiène). Pas de bug visible aujourd'hui, mais dette de
config qui peut mordre lors d'un futur changement de thème ou d'un debug
« pourquoi mes liens ne sont pas violets ».

## Demande précise

1. **Fusionner les 2 ConfigProvider** : ne garder QUE celui de `main.tsx`
   (le plus complet). Dans `__root.tsx`, retirer le `ConfigProvider` et son
   thème — garder seulement le `<div className="flex min-h-screen flex-col">`
   + DemoBanner/Outlet/DemoFooter. Vérifier que rien sous `__root` ne dépendait
   d'un override propre à ce 2e provider (a priori non, il ne fait que
   re-déclarer la primaire déjà héritée).
2. **Source unique de la primaire** : idéalement, lire `colorPrimary` depuis la
   CSS var `--primary` (`index.css`) pour n'avoir qu'UNE valeur. À défaut,
   harmoniser la casse partout en `#7763f1` (minuscule, comme la CSS var).
3. Laisser `veridian/theme.css` de côté ici — il est traité (et sa primaire
   teal supprimée) par le ticket P1 sur les panels.

## Note

À faire en passant, idéalement dans le même chantier que le P1 panels (touche
au thème global). Pas un sprint dédié.
