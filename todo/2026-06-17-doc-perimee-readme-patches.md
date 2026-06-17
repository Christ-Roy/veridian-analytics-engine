# Docs périmées : VERIDIAN-README.md (archi fausse) + PATCHES.md (patches déjà livrés)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : DOCUMENTER (corriger doc périmée qui contredit le code/CLAUDE.md)
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié)

Deux docs racine décrivent une réalité **obsolète** qui contredit directement
le `CLAUDE.md` à jour et le code.

### 1. `VERIDIAN-README.md` — architecture two-tier fausse

Le bloc « Architecture two-tier » (`VERIDIAN-README.md:23-33`) affirme :

```
veridian-analytics (Next.js, ce repo séparé)
    └─ Auth Veridian, intégration Hub, GSC, magic links
    └─ HTTP →  veridian-analytics-engine (CE repo, fork staminads)
```

et : *« Le repo `veridian-analytics` (séparé) reste la couche métier
Veridian. »*

**C'est faux sur deux points** :
- Le **bridge Veridian est DANS ce repo** (`veridian-bridge/`, Express +
  Postgres), pas dans un repo Next.js séparé. Le `CLAUDE.md:209-215`
  (« Architecture two-tier ») le dit explicitement : bridge + engine sont les
  deux tiers, **tous deux dans ce repo**.
- Le repo legacy `veridian-analytics` (Next.js) est **condamné à mort**
  (cf `veridian-analytics/CLAUDE.md` §VISION + memory
  `[[project_analytics_vision_scope_final]]`), pas « la couche métier active ».
  Toute la logique métier (auth, GSC, voip, provisioning M2M) a été **portée
  nativement dans cet engine** (modules `gsc/`, `voip/`, `admin-platform/`,
  vagues 2026-06-16/17).

Un agent qui lit ce README croit que le métier vit ailleurs et que GSC/auth
sont dans un Next.js externe → faux raisonnement garanti.

### 2. `PATCHES.md` — 3 patches « à implémenter » déjà livrés

`PATCHES.md:18-22` liste comme patches actifs :

| ID | Description | Statut affiché |
|---|---|---|
| 0001 | Visitor ID persistant | « À implémenter Phase 2 » |
| 0002 | Rebranding console (logo + couleurs) | « À implémenter Phase 5 » |
| 0003 | CGU + banner cookies snippet | « À implémenter Phase 2 » |

**Réalité** :
- **0001 visitor_id** : LIVRÉ (c'est la base du réconciliateur identité /
  tunnel, cf memories `[[project_analytics_engine_decisions]]`,
  `[[project_tunnel_connecteur_twenty_natif_design_b]]`). Le SDK pousse un
  `visitor_id` first-party — fondation de tout le scoring tunnel.
- **0002 rebranding** : LARGEMENT livré (console refondue en français
  2026-05-24, PR #28 ; refonte UI native pure). Reste de la dette branding
  ponctuelle (emails Staminads en dur — cf tickets subscriptions/mail), mais
  pas « à implémenter Phase 5 ».
- **0003 CGU/cookies** : à re-statuer (le snippet d'install + privacy section
  Settings existent ; vérifier l'état réel).

`PATCHES.md` est aussi le document que la licence AGPL impose de fournir à un
client qui réclame la source — il ne peut PAS rester faux.

## Demande précise

1. **`VERIDIAN-README.md`** : réécrire le bloc « Architecture two-tier » pour
   refléter bridge+engine dans ce repo, et retirer/clarifier la mention
   « `veridian-analytics` = couche métier » (le legacy est condamné, le métier
   est natif ici). Aligner sur `CLAUDE.md:207-220`.
2. **`PATCHES.md`** : passer 0001 et 0002 en « Livré » (avec SHA/PR si
   trouvables), re-statuer 0003 après vérif du code réel, et ajouter les
   patches Veridian réels livrés depuis (port natif GSC, port natif VoIP,
   admin-platform M2M, connecteur Twenty natif) — c'est ce qui DOIT figurer
   dans le doc AGPL « ce qu'on a patché vs upstream ».

## Impact

Doc d'onboarding (README) + doc de conformité légale (PATCHES/AGPL) toutes deux
fausses. Coût : raisonnement faux de tout nouvel agent + risque de non-conformité
AGPL si un client demande la source et reçoit un PATCHES.md mensonger.

## Liens

- Cartographie modules : `2026-06-17-doc-cartographie-modules-backend.md`
