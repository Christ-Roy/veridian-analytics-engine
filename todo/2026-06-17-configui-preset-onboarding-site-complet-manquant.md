# 🟡 Preset manquant : aucun onboarding « tracker un site client complet » (SDK + GSC + Calls) — le wizard ne couvre que le SDK

> **Sévérité** : 🟡 P1 — le parcours réel du produit n'est orchestré nulle part
> **Owner** : agent veridian-analytics-engine
> **Demandeur** : audit-configui (axe presets / usages métier composés)
> **Créé** : 2026-06-17

## Résumé

Le scope commercial Veridian Analytics = **3 features** (visiteurs uniques via
SDK + Calls VoIP + Search Console). Ces 3 briques existent et sont configurables,
chacune dans son onglet Settings. **Mais aucun preset / parcours guidé ne les
orchestre.** Le seul onboarding (`welcome.tsx`) ne couvre que l'étape 1 : poser
le snippet SDK. Un nouveau client n'est jamais guidé vers « connecte ta Search
Console » ni « branche ta téléphonie / mappe tes numéros par source » — alors
que c'est précisément ce qui différencie Veridian d'un analytics générique.

Résultat : un client onboardé via le wizard repart avec le SDK seul, et les
features Calls + GSC (qui font la valeur produit) restent découvertes au hasard,
si jamais. Le « produit complet » se compose de briques existantes qu'aucun
preset n'assemble.

## Preuve (2 bouts)

### Le produit = 3 features (vision figée)

`docs/AUDIT-COMMERCIAL-2026-05-25.md` + mémoire
`project_analytics_vision_scope_final` : visiteurs uniques + Calls OVH + Search
Console. La vision 2026-05-25 (`project_vision_2026-05-25_provisioning_telcalls`)
insiste : « 1 numéro par source (seo/ads/…) » = cœur de l'attribution, donc le
mapping numéros→sources fait partie du parcours d'activation, pas d'un réglage
secondaire.

### L'onboarding ne couvre qu'une brique sur trois

`console/src/veridian/pages/welcome.tsx:66-70` — le wizard a 3 étapes, toutes
sur le SDK :

```ts
const STEPS = [
  { label: 'Copie ton snippet', short: 'Snippet' },
  { label: 'Pose-le dans ton site', short: 'Installation' },
  { label: 'Vérifier', short: 'Vérification' },
];
```

Aucune étape « Connecter Search Console », aucune étape « Téléphonie ». Les
panels `search-console-panel.tsx` et `voip-panel.tsx` existent et marchent, mais
rien ne pointe le nouveau client vers eux après l'install du SDK
(`onComplete` redirige vers le dashboard, point final).

## Demande précise

Conforme à la vision (pas de page dédiée) — deux options, l'une OU l'autre :

**Option A (recommandée, ~70 %) — enrichir le wizard `welcome.tsx`** d'une 4e
étape « Pour aller plus loin » (non bloquante, skippable) qui présente 2 cartes :
- « Suivre vos appels téléphoniques » → lien vers Settings → Téléphonie/VoIP
- « Suivre votre référencement Google » → lien vers Settings → Search Console

Chaque carte affiche son état (connecté / non connecté) en lisant
`voip.settings` et `gsc.status`. Le wizard reste minimaliste (exception
onboarding tolérée par la vision).

**Option B — une « checklist d'activation » persistante** sur le dashboard
(petit widget natif, dismissable) : 3 items (SDK posé ✓/✗, GSC connecté ✓/✗,
≥1 numéro mappé ✓/✗) qui se cochent automatiquement. Pointe chaque item non fait
vers son onglet Settings. Visible jusqu'à complétion ou dismiss.

Dans les deux cas : **zéro nouvelle route**, juste de l'orchestration vers les
onglets Settings existants + lecture des statuts via les endpoints déjà câblés.

## Impact

- Sans preset : taux d'activation des features payantes (Calls/GSC) tributaire de
  la découverte spontanée. Le client ne « voit » pas le produit complet.
- Le mapping numéros→sources (cœur de l'attribution SEO vs Ads, vision
  2026-05-25) n'est jamais présenté au moment de l'onboarding → l'attribution,
  argument de vente n°1, n'est pas activée par défaut.
- Tier 🟡 MOYEN (UI onboarding/dashboard, lecture de statuts existants, pas de
  surface sensible).
