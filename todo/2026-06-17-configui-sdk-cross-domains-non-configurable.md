# 🟢 SDK : option `crossDomains` (suivi multi-domaines) supportée mais non configurable depuis l'UI

> **Sévérité** : 🟢 P2 — capacité SDK réelle, cas métier non couvert dans le snippet généré
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Demandeur** : audit-configui (axe config UI ↔ capacités backend)

## Résumé

Le SDK tracker supporte un suivi cross-domaines (`crossDomains`,
`crossDomainExpiry`, `crossDomainStripParams`) pour qu'une même session soit
partagée entre plusieurs domaines d'un même client (ex. `site.com` +
`blog.site.com` + `shop.site.com`). Cette capacité est inaccessible depuis la
console : aucun des snippets générés ne renseigne `crossDomains`, et aucun
réglage Settings ne le propose. Un client multi-domaines verra ses visiteurs
comptés en double (une session par domaine) sans aucun moyen de corriger ça
depuis l'UI.

## Preuve (2 bouts)

### SDK — la capacité existe

`sdk/src/types.ts:65-71` :

```ts
// Cross-domain tracking (URL decoration)
/** List of domains to share sessions with (e.g., ['blog.example.com', 'shop.example.com']) */
crossDomains?: string[];
/** Cross-domain param expiry in seconds (default: 120) */
crossDomainExpiry?: number;
/** Strip _stm param from URL after reading (default: true) */
crossDomainStripParams?: boolean;
```

(Le SDK supporte aussi `trackClicks`, `sessionTimeout`, `heartbeatTiers`,
`adClickIds` — voir `StaminadsConfig` lignes 44-72. Defaults raisonnables, donc
hors scope de ce ticket sauf `crossDomains` qui change le comptage métier.)

### UI — `crossDomains` jamais émis

Les 3 snippets générés (`welcome.tsx:88-94`, `install-sdk.tsx:73-80`,
`settings.tsx:541-549`) écrivent au mieux `workspace_id`, `endpoint`, `trackSPA`,
`trackScroll`. Aucun ne propose `crossDomains`. Aucun champ Settings ne le
configure.

## Demande précise

Onglet Settings concerné : **onglet « SDK »** (`section='sdk'`, existant — pas de
nouvelle route).

1. Ajouter dans l'onglet SDK un champ optionnel « Domaines additionnels à suivre
   ensemble » (liste de domaines, type tags/chips).
2. Si renseigné, **injecter `crossDomains: [...]`** dans le snippet généré
   (idéalement après centralisation du `buildTrackerSnippet`, cf ticket
   `2026-06-17-configui-snippet-sdk-url-404.md` qui propose la même refacto).
3. Persister le réglage dans `workspace.settings` pour que le snippet régénéré
   le conserve.

## Impact

- Comptage visiteurs faussé (double-comptage) pour tout client multi-domaines —
  c'est la feature n°1 (visiteurs uniques) qui devient incorrecte sur ce cas.
- Cas pas universel mais réel (client avec blog + boutique sur sous-domaines).
- À faire de préférence **après** le ticket de centralisation du snippet (#1),
  pour ne pas re-dupliquer la string une 4e fois.
- Tier 🟢 BAS / 🟡 MOYEN (UI Settings + génération de string, pas de surface
  sensible).
