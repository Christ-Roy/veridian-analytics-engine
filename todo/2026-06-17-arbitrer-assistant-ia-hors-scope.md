# Arbitrer l'assistant IA natif — feature livrée hors des 3 features figées

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Type** : ARBITRER (puis documenter OU débrancher/archiver) — décision Robert
> **Source** : audit parité doc + modules orphelins (axe audit-doc)

## Constat (vérifié)

L'engine embarque un **assistant IA complet et fonctionnel**, monté
globalement dans la console, qui n'apparaît **dans AUCUNE des décisions de
scope de Robert** (ni la VISION 2026-05-25 du `CLAUDE.md`, ni la vision legacy
2026-05-23, ni les memories). Il n'est ni dans les « 3 features visibles
client » figées, ni dans la liste anti-régression « ce qui ne doit PAS être
ajouté ». C'est un **angle mort de gouvernance**.

### Ce qui existe réellement

**Backend** (`api/src/assistant/`) :
- Vrai agent conversationnel Anthropic (`@anthropic-ai/sdk`), modèle de chat
  par workspace + `claude-haiku-4-5` pour les titres
  (`assistant.service.ts:9,237,465`).
- Tool-loop avec tools internes (`get_dimension_values`, `preview_query`,
  `configure_explore`), streaming SSE, rate-limiter en mémoire, pricing.
- Endpoints `POST assistant.chat` + `GET assistant.stream/:jobId`
  (`assistant.controller.ts:29,51`, `WorkspaceAuthGuard`).
- Type `'openai'` déclaré mais **mort-né** (`integration.entity.ts:48`
  `export type Integration = AnthropicIntegration`).

**Frontend actif** (`console/src/components/Assistant/`) :
- FAB flottant + drawer montés sur **toutes** les pages workspace
  (`$workspaceId.tsx:628-629`, commentaire `:625` « available on all
  workspace pages »).
- Contexte + hooks (`useAssistant.ts`, `useAssistantStorage.ts`), historique
  localStorage. Gating via Settings → Intégrations
  (`components/settings/IntegrationsSettings.tsx:148`).

**Spec dédiée** : `docs/specs/ai-assistant-page.md` (639 lignes) décrit
l'enhancement « assistant global persistant ». NB : c'est un **panel
flottant**, PAS une route dédiée → ne viole PAS la règle « pas de sous-route
Veridian » (vérifié : aucune route `assistant.tsx`/`ai.tsx`/`chat.tsx`).

### Mais : dormant en pratique

- **Aucune clé Anthropic câblée** : pas d'ENV `ANTHROPIC*` dans
  `compose/base.yml` / `compose/prod.yml` / `compose-demo.yaml`. La clé est
  stockée par workspace, chiffrée — et **aucun endpoint ne permet de la
  poser** (pas de route de config intégration dans `workspaces.controller.ts`,
  seulement le path générique `workspaces.service.ts:277`).
- `createJob` jette `BadRequestException` « Anthropic integration not
  configured » tant que la clé est absente (`assistant.service.ts:111-115`).
- Donc : panel visible (si intégration activée) mais **non fonctionnel** en
  prod par défaut.

### Code mort résiduel à signaler

- `console/src/components/explore/AssistantButton.tsx` + `AssistantPanel.tsx`
  = **doublon orphelin** (aucune référence — le composant monté est
  `components/Assistant/*`). Pire : libellés en **anglais** (« Close
  assistant », « Ask AI to create a report » — `explore/AssistantButton.tsx:13`)
  → violerait la règle français-only s'ils étaient affichés.

## Décision à faire (Robert)

L'assistant IA « query your data in plain English » est un argument commercial
fort (cf README upstream `:23`). Mais il est hors scope figé, dormant, et
coûte en surface (LLM Anthropic à payer, prompt-injection à sécuriser).

- **Option A — Assumer comme 4e feature** : câbler une clé Anthropic
  plateforme (ou par workspace via UI), documenter dans la VISION, sécuriser
  (rate-limit déjà présent, vérifier prompt-injection sur les tools). Coût :
  budget LLM récurrent + sprint sécu/UX.
- **Option B — Débrancher/archiver** (cohérent avec score/shadow/forms) :
  retirer le montage du panel, archiver le module sous `_archive/` ou le
  parking permanent, le sortir de la spec active. Garde le code pour
  réactivation future décidée par Robert.

**Reco** : trancher A vs B explicitement, ne pas laisser un panel IA non
fonctionnel monté en prod sans gouvernance. Dans les deux cas : **supprimer le
doublon mort `components/explore/Assistant*`** (gain immédiat, zéro risque).

## Impact

Un assistant IA visible mais cassé (clé absente) = mauvaise impression client.
Une capacité native non arbitrée = risque qu'un agent investisse dessus sans
mandat, OU qu'un autre la re-développe en l'ignorant. La présence d'une spec de
639 lignes laisse penser que c'était un chantier sérieux — d'où le besoin d'un
arbitrage clair.

## Liens

- Cartographie modules : `2026-06-17-doc-cartographie-modules-backend.md`
- Hygiène fichiers résiduels : `2026-06-17-hygiene-fichiers-residuels-console.md`
