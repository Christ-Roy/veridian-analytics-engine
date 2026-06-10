# Events custom — contrat d'extension de la plateforme

> **Audit terrain 2026-06-10** (tâche team #25, priorité Robert) : jusqu'où
> un client peut-il définir SES events et SA logique **sans modifier le code
> de l'engine ni migrer ClickHouse**. Tout ce qui suit a été VÉRIFIÉ en réel
> sur staging (workspace `vrd_veridian_site_staging`, session
> `audit25-1781100673`) — pas déduit de la doc.
>
> TL;DR : **l'extensibilité est native à ~90 %**. Un event custom = 1 appel
> SDK, zéro déploiement. Deux gaps de REQUÊTABILITÉ API + un point de
> capture à durcir (détail §4).

---

## 1. Le contrat d'extension (ce qu'un client/intégrateur peut faire SEUL)

### Définir un event custom : un seul appel SDK, aucun déploiement

```js
// N'importe quel nom (≤ 100 chars), n'importe quelles properties.
Staminads.trackGoal({
  action: 'devis_telecharge',          // event inédit — JAMAIS déclaré côté engine
  value: 42.5,                          // optionnel, numérique
  properties: { offre: 'pro', pdf: 'tarifs-2026' },  // clés/valeurs libres
});
```

**Vérifié en réel** : un goal au nom jamais vu (`evenement_jamais_vu_x99`)
avec des clés de properties arbitraires est accepté (200), stocké dans
ClickHouse (`events.goal_name`, `events.properties Map(String,String)`) et
ressort tel quel — **sans aucune modification de schéma ni de code**.

### Valeurs non-string : castées, jamais perdues

Properties envoyées `{count: 5, ratio: 0.83, nested: {a: 1}, bool: true}` →
stockées `{'count':'5','ratio':'0.83','nested':'{"a":1}','bool':'true'}`.
Le pipeline d'insertion sérialise proprement (JSON pour les objets). Règle
d'usage à documenter aux intégrateurs : **valeurs scalaires en string de
préférence** ; les objets imbriqués survivent mais en JSON-string (à parser
côté consommateur).

### Identité et dimensions

- `Staminads.setUserId(<id>)` : identité libre (≤ 256 chars) — slug, email,
  id client. Rétro-attribue toute la session (ReplacingMergeTree).
- `setDimension(1..10)` / URL `?stm_1=` : 10 dimensions custom **par
  workspace** (= par client), labellisables en Settings, requêtables dans
  Explore. La limite de 10 est PAR CLIENT (1 client = 1 workspace) — non
  bloquante en multi-client ; le mécanisme illimité, ce sont les properties.

### Garde-fous existants (limites du contrat)

| Limite | Valeur | Source |
|---|---|---|
| Nom de goal | ≤ 100 chars, non vide | `MAX_GOAL_NAME_LENGTH` (DTO) |
| Actions par session | ≤ 1000 | `MAX_ACTIONS` |
| Path | ≤ 2048 chars | `MAX_PATH_LENGTH` |
| Timestamps | bornés ±24 h (skew corrigé) | `TIMESTAMP_BOUNDS_HOURS` |
| user_id | ≤ 256 chars | DTO + SDK |
| Champs d'enveloppe inconnus | **strippés silencieusement** | `ValidationPipe whitelist:true` |

## 2. Où les events custom sont-ils VISIBLES / REQUÊTABLES ?

| Surface | État | Détail |
|---|---|---|
| ClickHouse SQL direct | ✅ | `goal_name` + `properties['cle']` requêtables (bloom index sur name) |
| Dashboards staminads (Live/Explore/Goals) | ✅ pour `goal_name` | `goal_name`/`goal_path`/`goals` sont des dimensions du query layer ; les events custom apparaissent automatiquement |
| Dimension sur les **properties** dans Explore | ❌ gap | `properties` n'est PAS une dimension filtrable du query layer (cf §4.G2) |
| `GET /api/export.userEvents` | ⚠️ gap | retourne `goal_name`/`goal_value` mais **PAS `properties`** (absentes du SELECT — cf §4.G1) |
| Webhooks destinations (staging, non promu) | ✅ | `event.tracked` porte `goal_name` + `properties` (fan-out par workspace) |

## 3. Capture exhaustive — état réel

- ✅ **Goal au nom inconnu** : accepté, stocké, visible. Jamais droppé.
- ✅ **Properties aux clés inconnues** : acceptées, stockées (castées).
- ✅ **Échec d'insertion ClickHouse** : le buffer RE-ENFILE les events et
  rejette l'erreur (pas de perte silencieuse — `event-buffer.service.ts`).
- ✅ **`email.opened`-style "type connu plus tard"** : un goal name non
  anticipé ne casse rien (c'est juste une valeur de colonne).
- ❌ **Action d'un TYPE inconnu** (ni `pageview` ni `goal`) : **400 et TOUT
  le payload est rejeté, y compris les actions valides du même batch**
  (vérifié : `{"type":"futur_type_inconnu"}` + 1 pageview valide → les deux
  perdus). Le SDK actuel n'émet jamais ça, mais pour une plateforme
  "jamais-drop" c'est LE point à durcir (§4.G3).

## 4. Gaps identifiés → dev proposé (tout est additif)

| # | Gap | Dev | Taille |
|---|---|---|---|
| G1 | `export.userEvents` ne retourne pas `properties` → les consommateurs API (dont le bridge tunnel) ne voient pas `depth`, `slug`, props custom | ajouter `properties` au SELECT + DTO réponse | XS (1 colonne, additif) |
| G2 | properties non filtrables dans Explore (UI) | dimension dynamique `properties['k']` dans le query layer | M (chantier upstream, à scoper si demande client) |
| G3 | action type inconnu = drop-all 400 | mode tolérant : skipper l'action inconnue (stockée en quarantaine `name='unknown'` + payload en properties), ingérer le reste, répondre 200 avec compteur `skipped` | S |

**Reco priorité** : G1 tout de suite (bloque la richesse du scoring tunnel
— sans lui le bridge n'a que `goal_name`+`path`, pas `depth` ni `slug` des
properties), G3 avant commercialisation multi-client, G2 sur demande.

## 5. Le scoring = un CONSOMMATEUR, et la grille restera configurable

Conformément à la réorientation produit : le scoring tunnel
(`veridian-tunnel-de-vente/bridge/src/score-tunnel.ts`) est une **fonction
pure** `(signaux) → score` totalement extérieure à l'engine. L'engine ne
connaît AUCUNE logique de scoring — il capture et sert les events.

Chemin vers le data-driven SANS refactor (critère "pas de dette à la
revente") : la table de points est une constante locale de la fonction ;
la rendre configurable = la passer en paramètre
(`computeTunnelScore(signaux, grille)`) chargé depuis un JSON par
workspace/client. Aucune autre pièce à toucher : l'agrégation (events →
signaux) et l'écriture (score → CRM) sont déjà découplées. Pour CE sprint
la grille tunnel reste en dur (validée lead, consent = 0 point).

## 6. Argument commercial (résumé pour la vente)

> « Vous définissez vos propres événements en une ligne de JavaScript —
> nom libre, données libres — sans ticket, sans déploiement, sans
> migration. Ils apparaissent immédiatement dans vos dashboards et sont
> exploitables par API pour vos automatisations (CRM, scoring, webhooks). »

C'est vrai dès aujourd'hui pour la capture + dashboards ; « exploitables
par API » devient 100 % vrai avec G1.
