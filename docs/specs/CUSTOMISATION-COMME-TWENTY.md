# Customisation "comme Twenty" + data par prospect — plan consolidé

> Spec consolidée 2026-06-25 (3 audits read-only HUNT-A/B/C + data prod réelle).
> Direction Robert : app customisable comme Twenty, SANS réécriture, vite et complet.
> Cible : piloter UI + data affichée par API + templates par type de client +
> vue data-par-prospect 360.

## Verdict global des audits

**On est déjà à ~80% de la cible. On ne réécrit RIEN.** On vole 2 patterns de
Twenty et on les pose sur le layer config existant (settings JSON + M2M
`/api/admin/platform/*`).

| Axe | État | Trou réel |
|---|---|---|
| Customisation backend (branding/features/layout/funnels) | ~80% via API M2M, settings JSON extensible zéro-migration | **templates** au provisioning |
| Data par prospect (provenance/compte/parcours/Ads) | ~85%, data en base, S6 + ads.conversions livrés | **endpoint prospect360 M2M** (export.userEvents gated workspace-key) |
| UI customisable (onglets/widgets pilotables) | 8 widgets en dur (array React) | **registry widget + widget=config group-by** |

## Décision d'architecture (HUNT-B, validée)

NI plugins externes (sur-ingénierie pour 5 clients), NI metadata lourde façon
Twenty (c'est un CRM relationnel, nous = analytics time-series ClickHouse fixe).
→ **Config légère en base + registry + templates.** On vole 2 patterns Twenty :
1. **Registry `widgetKind → composant`** : nos 8 widgets array hardcodé
   (`DashboardGrid.tsx`) → registre adressable par clé.
2. **Widget/funnel = DESCRIPTION d'un group-by** `{metric, dimension, agrégat,
   granularité, filtre}` résolu par UN query-builder ClickHouse générique.
   = généralisation de `crm_mapping.goals[]` (déjà livré) aux widgets/funnels.
ON NE COPIE PAS : metadata objets relationnelle, système vues complet (ViewField/
Filter/Sort/Group), 25 field-types, double-store metadata. Ni sous-routes Veridian
(vision UI native 2026-05-23).

## Vagues d'exécution (ordonnées par valeur/effort)

### VAGUE 1 — Quick wins (data déjà là, ~1j chacun, EN COURS)
- **Templates provisioning** (EXEC-T) : champ `template` au provisionTenant +
  presets JSON e-commerce/vitrine/webapp (branding+features+layout+funnels crm)
  appliqués via M2M existant. CLI `provision --template`.
- **Prospect 360** (EXEC-P) : endpoint M2M `analytics.prospect360` (PlatformAdminGuard)
  composant userProvenance + export.userEvents (parcours) + ads.conversions par
  user_id. CLI `analytics prospect <ws> --user <email>`. Débloque l'IA/Hub.

### VAGUE 2 — Customisation UI data-driven (le "comme Twenty")
- **Registry widgets** : basculer les 8 widgets de l'array React hardcodé vers un
  `Record<widgetKind, composant>` adressable par clé (console). Catalogue source
  unique (résoudre le smell : widget keys dupliqués api/console).
- **Widget = config group-by** : un widget défini par `{metric, dimension, agrégat,
  granularité, filtre}` résolu par le query-builder ClickHouse générique existant.
  setLayout étendu pour DÉFINIR des widgets, pas juste reorder/hide un catalogue fermé.
- **Funnels configurables** : généraliser au funnel (étapes = goals/events config
  par workspace, tracker adapté tel/form/autre).
- ⚠️ Touche la frontière "UI staminax native intouchée" (vision 2026-05-23) — mais
  la direction Robert 2026-06-25 ("charcuter sans hésiter, comme Twenty") l'élargit.
  Reste dans le dashboard natif (pas de sous-route Veridian).

### VAGUE 3 — Profondeur (arbitrage / selon besoin)
- Nav/onglets/pages pilotables par workspace (gating) — si besoin client réel.
- Google Ads : vue "prospects entrés via Ads + où ils en sont" (croise
  userProvenance(group=ads) + parcours). gclid déjà capté, first-party, sans API Google.
- Session replay niveau B (vue parcours console depuis export.userEvents).

## Sujets COLLECTE (arbitrage business, pas technique)
- **TTL events 7j** : parcours détaillé brut limité à 7j glissants (sessions=30j,
  agrégats au-delà). Allonger le TTL = coût stockage ClickHouse. À trancher.
- Session replay vidéo (rrweb niveau C) = gros chantier + RGPD lourd, hors quick-win.

## Pièges (mémoires)
- ZÉRO build local (RAM 7.6Gi). e2e VRAI ClickHouse + sabotage (mock cache le bug).
- Rebase avant commit (worktree partagé = clobber, déjà vécu cette session).
- Tester Twenty via REST workspace test, JAMAIS le MCP (prod réelle).
- Spec S6 §Lot TWENTY "pas de patchPerson" = PÉRIMÉ (livré). export.userEvents M2M
  = le seul TODO S6 non fait (= VAGUE 1 prospect360).

## Rapports d'audit (scratchpad)
hunt-custom-existant.md · hunt-twenty-model.md · hunt-data-prospect.md
