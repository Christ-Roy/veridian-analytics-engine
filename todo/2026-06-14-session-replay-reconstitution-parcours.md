# Reconstitution du parcours visiteur (timeline détaillée + étude session-replay)

> **Sévérité** : 🟢 P2 — feature commerciale, pas urgent (à étudier plus tard)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-14
> **Demandeur** : Robert

## Besoin business

Donner au commercial une **reconstitution de ce qu'a fait un visiteur sur le site**
(surtout les pages `/audit/[slug]`) avant de l'appeler : quelles pages, dans quel
ordre, scroll, clics, temps passé. "Voilà ce que ce prospect a regardé."

## 3 niveaux possibles (à arbitrer après étude d'impact)

### Niveau A — Timeline enrichie dans la fiche Twenty (le moins cher)
- DÉJÀ à moitié là : le connecteur natif pousse audit.page_view/scroll/cta_click/rdv
  dans la timeline Twenty (prouvé prod 2026-06-14).
- Enrichir : + temps passé, + ordre exact, + pages hors audit.
- Effort : faible. Avantage : là où le commercial bosse déjà.

### Niveau B — Vue parcours détaillée dans la console analytics
- Reconstituer chronologiquement TOUT depuis `GET /api/export.userEvents` (par user_id
  = slug ou email). La matière existe à 100%.
- Vues staminads natives Live (`console/.../live.tsx`) + Explore (`explore.tsx`)
  EXISTENT déjà → vérifier si elles affichent le parcours par visiteur tel quel,
  sinon adapter.
- Effort : moyen. ⚠️ Respecter la règle UI native (pas de sous-route custom Veridian,
  cf CLAUDE.md — passer par l'existant staminads ou un onglet).

### Niveau C — Session replay vidéo (le "film" de la souris, type Hotjar/Clarity)
- Rejouer l'écran du visiteur (mouvements souris, scroll, clics) comme une vidéo.
- ❌ N'existe PAS nativement (pas de rrweb dans le SDK, seulement des fixtures démo).
- Gros chantier : intégrer rrweb dans le SDK, capture + stockage DOM continu, player.
- ⚠️ RGPD LOURD : enregistrer l'écran = donnée perso massive, base légale + masquage
  des champs sensibles (mots de passe, formulaires) + consentement explicite + durée
  de conservation. À ne pas prendre à la légère.

## Étude d'impact à mener AVANT de coder (livrable de ce ticket)

1. **Faisabilité technique** : staminads stocke-t-il assez d'events pour reconstituer
   (Niveau B) ? rrweb compatible avec le SDK patché Veridian (Niveau C) ? Coût stockage
   ClickHouse du record DOM ?
2. **Faisabilité RGPD** (surtout Niveau C) : base légale, masquage, conservation, le
   tracker est consent-gated ou non (cf décision Robert 2026-06-11 : SDK sans gate
   consent sur veridian.site, "j'assume" — mais un replay vidéo change la donne).
3. **Reco niveau** : A (quasi gratuit, suffit probablement) vs B vs C.
4. **Chiffrage** effort + coût récurrent (stockage).

## Note

Robert (2026-06-14) : pour son usage outbound (prospects connus, tél déjà en base),
le besoin réel = "savoir ce que le prospect a regardé avant de l'appeler". Le Niveau
A ou B suffit très probablement ; le C (vidéo) est un nice-to-have coûteux + RGPD.
