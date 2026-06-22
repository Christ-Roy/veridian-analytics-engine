# 🟡 Funnel (tunnel de vente) analytique avec filtre par canal

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-22
> **Dépend de** : `2026-06-22-channel-jamais-calcule-attribution-borgne.md` (le filtre canal)

## Demande (Robert 2026-06-22)

Un **funnel / tunnel de vente** qui montre les étapes (visite → … → conversion)
avec le **taux de passage entre étapes**, et **filtrable par canal** (ads / seo /
direct / autres). Pour répondre à : « combien convertissent, et d'où viennent-ils ».

## Constat (audit 2026-06-22) — ce qui existe / manque

EXISTE :
- Table `sessions` + `goals` (events de conversion : `phone_call`, `form_submission`,
  `signup`, `app_started`, customs). Goals portent `goal_name` + `properties`.
- Dimensions de canal (`channel`/`channel_group` — ⚠️ vides tant que le ticket
  prérequis n'est pas fait), `utm_*`, `referrer`, `phone_source`.
- `DimensionTableWidget` (breakdown plat), `GoalDashboardDrawer` (un goal détaillé).

MANQUE :
- **Aucun composant funnel** dans la console (`grep funnel|conversion-path
  console/src` = 0). Pas de notion d'étapes ordonnées ni de taux entre étapes.
- Pas d'endpoint analytics « funnel » (séquence d'étapes → comptes + drop-off).

## Demande précise

### Backend — endpoint funnel
Un endpoint (workspace-scoped + équivalent M2M `ads`/admin) qui prend une
**définition de funnel** = liste ordonnée d'étapes (chaque étape = un goal_name ou
un événement, ex : `[pageview, form_submission]` ou `[visite, phone_call]`), une
plage de dates, et **des filtres** (dont `channel`/`channel_group`). Renvoie pour
chaque étape : nombre de sessions/visiteurs uniques atteignant l'étape + le taux de
conversion étape N→N+1 + le taux global. Calcul en ClickHouse (windowFunnel() est
exactement fait pour ça — fonction native CH `windowFunnel(window)(timestamp,
cond1, cond2, …)`).

### UI — vue funnel native staminads
Une vue funnel (graphe en entonnoir) avec :
- Sélection des étapes (parmi les goals du workspace).
- **Filtre par canal** (réutilise `DashboardFilters` + dimension `channel`/
  `channel_group`) → comparer le funnel ads vs seo vs direct.
- Taux de passage entre étapes + drop-off visible.
- Respecter la vision : natif staminads, PAS de page custom Veridian dédiée — soit
  une vue staminads native si elle existe, soit un onglet dashboard. À vérifier si
  staminads upstream a un funnel (port perdu ?) avant de partir de zéro.

## Points d'attention
- `windowFunnel` CH : choisir la fenêtre (session ? 30 jours ?) et la clé
  (`session_id` ou `visitor_id`/`user_id` pour le cross-session).
- Le filtre canal n'a de sens QUE si le channel est calculé (ticket prérequis).
- Performance : borner les étapes (≤ 8) et la plage de dates.

## Lien
Roadmap : `2026-06-22-ROADMAP-skill-analytics-et-integrations-surmesure.md`.
