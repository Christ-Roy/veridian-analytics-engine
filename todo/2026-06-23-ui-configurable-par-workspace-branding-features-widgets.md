# App configurable par workspace : branding + features + widgets + sémantique tracking→CRM (pilotable M2M, multi-industrie, cible Hub white-label)

> **Sévérité** : 🟠 P1 (structurant — N4 = prérequis pour vendre à n'importe quelle industrie)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23
> **Demandeur** : Robert
> **Dépend de** : ne PAS lancer tant que la vague sécu/visiteurs-uniques en cours
> n'est pas mergée (chevauche `workspaces/` + front dashboard = collisions).

## Objectif

L'agent qui provisionne et configure un client (skill `analytics-provision`, API M2M)
doit pouvoir **adapter l'UI du dashboard à chaque client** sans toucher au code par
site, et SANS créer de sous-route custom (respect strict de la vision 2026-05-23 :
tout passe par staminads natif + onglets Settings). Cible long terme : **généraliser
le white-label depuis le Hub** (cohérent avec le pricing Business+ white-label).

Robert (2026-06-23) : *"il faut que ce soit configurable et plus tard sans doute que
depuis Hub on généralisera le white branding"*.

## Les 3 niveaux à livrer

### Niveau 1 — Branding par client (le plus simple, partiellement là)
- **Déjà dispo en données** : le workspace a `logo_url`, `color` (hex, défaut `#7763f1`),
  `name`, `website`, modifiables via `POST /api/admin/platform/workspaces.updateSettings`.
- **MANQUE** : le branding VISUEL de la console est **figé "Veridian" en dur**
  (`console/src/veridian/auth-shell.tsx`, fix upstream-branding-cleanup 2026-05-23 —
  la config workspace ne pilote plus le branding visuel). → **Défiger** : faire lire au
  shell console le `logo_url`/`color`/`name` du workspace courant pour appliquer le
  branding par client (titre doc, favicon, logo header, couleur d'accent). Garder le
  défaut Veridian quand rien n'est configuré.
- Résultat : l'agent appelle `updateSettings {logo_url, color, name}` → le client voit
  SON branding. C'est la brique white-label de base.

### Niveau 2 — Visibilité des onglets/sections selon les features souscrites
- **Constat** : aujourd'hui TOUS les onglets Settings (VoIP, Search Console…) sont
  affichés pour tout le monde. Un client sans l'option Calls voit quand même l'onglet
  VoIP. Il n'existe **aucune notion de "features actives par workspace"** côté entité.
- **À créer** : un champ `features` / `enabled_modules` dans la config workspace
  (loger dans le `settings` profond ou une colonne dédiée — décider à l'implémentation),
  ex `{ voip: true, gsc: false, calls: true }`. Pilotable par M2M
  (`updateSettings` ou un endpoint dédié `workspaces.setFeatures`).
- **Front** : la sidebar Settings + les sections lisent ces flags et masquent
  proprement les onglets non souscrits (PAS de menu grisé / mur béton — interdits par
  la vision pricing ; juste ne pas afficher l'onglet). Rester dans le mécanisme natif
  staminads (extension du `z.enum section`, pas de route custom).
- Cohérence avec l'existant : les panneaux se replient déjà selon leur ÉTAT de connexion
  (`not-connected`). Ici c'est différent : masquer selon ce qui est SOUSCRIT, pas selon
  ce qui est connecté.

### Niveau 3 — Layout / widgets du dashboard par client
- **Objectif** : l'agent configure quels widgets/métriques sont mis en avant sur le
  dashboard principal selon le profil client (ex : un client télé-centré → appels en
  hero ; un client SEO → GSC en avant).
- **À créer** : un schéma de layout par workspace (liste ordonnée de widgets +
  visibilité), loger dans la config workspace, pilotable M2M. Le dashboard natif
  staminads lit ce layout pour ordonner/afficher ses widgets.
- ⚠️ C'est le niveau le plus lourd (touche le dashboard natif). Cadrer l'implémentation
  pour rester dans staminads (config de widgets existants, PAS de nouveaux composants
  custom Veridian). Si staminads n'expose pas de système de layout configurable
  exploitable, RAPPORTER avant de coder un truc lourd — possible qu'on se limite à
  ordonner/masquer les widgets natifs existants.

### Niveau 4 — 🔴 Sémantique tracking→CRM configurable par workspace (le plus structurant)

> Ajouté 2026-06-23 après le branchement Yoga Sculpt. C'est le cœur du « l'app doit
> être modulaire/ajustable par API pour servir n'importe quelle industrie » (Robert).
> Aujourd'hui le pont analytics→CRM est **codé en dur pour UN cas d'usage** (prospection
> "site-audit") → inexploitable pour un autre métier (yoga, e-commerce, immo…) sans
> recoder le connecteur.

**Constat (vérifié sur le code) :**
1. **Mapping goals → timeline CRM HARDCODÉ** dans `api/src/webhooks/connectors/twenty-event-mapper.ts` :
   `CTA_GOALS`, `RDV_GOALS = {'rdv_booked'}`, `AUDIT_VIEW_GOALS = {'audit_view','audit_page_view'}`,
   `SIGNUP_GOALS`, `APP_STARTED_GOALS`, `APP_STARTED_TIMELINE_APPS = {'notifuse','prospection'}`
   (l.35-54). Un goal hors de ces Sets → `0 milestone` (ignoré). Donc les goals Yoga
   Sculpt (`cta_espace_click`, `purchase`, `reservation_confirmed`, `onboarding_complete`…)
   **ne remontent PAS au CRM** : ils sont inconnus du mapper.
2. **Résolution d'identité figée email/slug** : le mapper attend `user_id` = email (`@`)
   ou slug (`twenty-event-mapper.ts` l.77-81, `normalizeIdentity(p.user_id)`). Or côté app
   Yoga Sculpt, `setUserId()` envoie l'**UUID Supabase**, pas l'email → la Person CRM ne
   se résoudrait jamais (UUID ≠ email) → tout en `orphans`.
3. **Conséquence** : même en branchant le connecteur Twenty sur Yoga Sculpt, **zéro fiche
   enrichie** ne partirait correctement. Le pont marche UNIQUEMENT pour le métier prospection.

**À livrer (configurable par workspace, pilotable M2M) :**
- **Catalogue de goals par workspace** : déclarer, par workspace via l'API, quels
  `goal_name` sont des "milestones CRM", avec leur libellé/type de timeline activity et
  leur valeur. Remplace les `Set` hardcodés par une config lue depuis le workspace.
  Ex Yoga Sculpt : `purchase → "Achat ticket" (value)`, `reservation_confirmed → "Réservation"`,
  `onboarding_complete → "Onboarding terminé"`.
- **Résolution d'identité configurable** : permettre de déclarer SUR QUEL champ résoudre
  la Person (email, ou un trait custom = UUID Supabase mappé vers un champ Twenty), OU
  prévoir un `identify` qui envoie l'email en plus de l'UUID. Décider le contrat :
  soit le SDK/app `setUserId(email)`, soit le workspace déclare "mon user_id = UUID, le
  champ Twenty de matching = X".
- **Mapping vers les objets CRM configurable** : quel goal crée/enrichit quel objet
  (Person, Opportunity, custom object) et quels champs — pour servir des industries dont
  le modèle CRM diffère (immo = "bien visité", e-commerce = "panier"…).
- **Généricité** : sortir la logique métier (`audit.*`, `notifuse/prospection`) du code
  vers de la **config par workspace** (loger dans `settings` ou table dédiée), pilotable
  M2M. Le mapper devient un moteur générique piloté par config, plus un switch en dur.

**Localisation** : `api/src/webhooks/connectors/twenty-event-mapper.ts` (le switch en dur),
`twenty-connector.service.ts` (résolution Person l.213 `resolvePersonId`),
config workspace (`api/src/workspaces/`). Lié aux tickets `2026-06-14-brancher-connecteur-twenty-workspace-reel.md`
(activation réelle) et `2026-06-23-reporting-acquisition-visiteur-unique-sources-funnel.md`
(le `user_id`/identité côté ingestion).

⚠️ Niveau le plus structurant : c'est ce qui rend l'app **vendable à n'importe quelle
industrie** sans recoder. À cadrer avec l'agent (gros chantier, sépare-le des N1-N3 UI
si besoin — c'est de la DATA/intégration, pas de l'affichage).

## Exposition API M2M (transverse aux 4 niveaux)
Tout doit être pilotable par l'agent via l'API admin M2M (le skill `analytics-provision`
en fait la doc). Étendre `workspaces.updateSettings` (ou ajouter `workspaces.setFeatures`
/ `workspaces.setLayout`) pour que l'agent provisionneur configure branding + features +
layout en S2S, sans console. Mettre à jour le skill `analytics-provision` + le CLI
`analytics` (commande `analytics ui:set <ws> --logo … --color … --features … --layout …`
ou équivalent) une fois le contrat figé.

## Cible Hub (phase ultérieure, NE PAS implémenter ici, juste ne pas fermer la porte)
À terme le Hub pilotera le white-label de façon centralisée (1 client Hub → branding
propagé à toutes ses apps). Le contrat M2M de ce ticket doit être assez générique pour
que le Hub l'appelle plus tard (même surface que l'agent provisionneur). Ne pas coder le
volet Hub maintenant ; juste concevoir l'API pour qu'il puisse s'y brancher.

## Localisation (points d'entrée)
- M2M : `api/src/admin-platform/admin-platform.controller.ts` + `…service.ts` (méthode
  updateSettings, l.~747) + `dto/update-workspace-settings.dto.ts`
- Workspace : `api/src/workspaces/` (entity, dto, service) — où loger `features`/`layout`
- Front branding figé à défiger : `console/src/veridian/auth-shell.tsx`
- Front sections/onglets : `console/src/veridian/settings-panels/*`
- Skill + CLI : `~/.claude/skills/analytics-provision/`

## Découpage suggéré (quand lancé)
Faisable en 1 agent si séquencé N1→N2→N3, ou 2 agents (un API+features, un front+branding)
avec coordination sur `workspaces/`. Niveau 1 (branding) + Niveau 2 (features) sont le
ROI immédiat ; Niveau 3 (layout) est à arbitrer selon ce que staminads permet.

## Impact si non fait
- (N1-N3 UI) L'agent provisionneur livre à tous les clients la même UI générique Veridian,
  onglets de features non souscrites visibles, pas de white-label → différenciation
  Business+ (white-label) non livrable, dashboard non adaptable au métier.
- (N4 data/CRM) Le pont analytics→CRM ne marche QUE pour le métier prospection
  (mapping/identité hardcodés) → impossible de vendre l'enrichissement CRM à une autre
  industrie sans recoder le connecteur. C'est le blocage le plus structurant pour le
  « service précis pour n'importe quelle industrie » (Robert 2026-06-23).
