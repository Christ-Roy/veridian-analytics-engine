# Publier le SDK engine en prod pour brancher le tunnel de vente

> **Sévérité** : 🔴 P0 — bloquant tunnel de vente Veridian
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-02
> **Demandeur** : Robert (via agent legacy `veridian-analytics`)
> **Spec parent** : [`veridian-platform/TUNNEL-DE-VENTE.md`](../../veridian-platform/TUNNEL-DE-VENTE.md) §6 étape 2

---

## Contexte business

Le tunnel de vente Veridian est en cours d'implémentation (cf
`TUNNEL-DE-VENTE.md`). L'étape 1 (consent banner + pixel Google Ads + 7
audiences remarketing) est livrée sur `veridian.site` depuis 2026-05-31.

**Prochaine étape figée par Robert (2026-06-02) — étape 2 du tunnel** :

> "Tracking site → Analytics : capter UTM + visitor_id + events,
>  les envoyer à l'engine. Première brique du vrai tunnel."

Sans cette brique, **aucune des étapes 3-8 du tunnel** (identify,
enrichissement, scoring, sync CRM Twenty) ne peut commencer. C'est le
P0 absolu côté engine.

## Ce qui existe déjà

Le repo engine contient déjà un dossier `sdk/` complet :

- `sdk/src/` — code source TypeScript du tracker
- `sdk/dist/` — build produit
- `sdk/rollup.config.js` — bundler
- `sdk/tests/` — tests Vitest + Playwright
- `sdk/package.json` — package npm en cours
- `sdk/README.md` — doc utilisateur
- `sdk-api-analysis-report.md` (racine) — audit fait le 2026-01-08
  identifiant 3 bugs SDK↔API à fixer

**Ce qui manque** : publication du SDK installable + adapter le site
veridian.site pour le consommer + smoke prod.

## Livrables attendus

### L1 — SDK publié et installable (P0)

**Deux modes de distribution doivent marcher** :

1. **Snippet `<script>`** (cas n°1 — sites client static + veridian.site) :
   ```html
   <script
     src="https://analytics-engine.app.veridian.site/sdk/v1/tracker.js"
     data-site-id="vrd_xxxxx"
     defer
   ></script>
   ```
   Servi en `Cache-Control: public, max-age=3600` depuis l'engine. URL
   versionnée `v1/` pour figer breaking changes futurs.

2. **Package npm public** (cas n°2 — sites Next.js / React avancés) :
   ```bash
   pnpm add @veridian/analytics-tracker
   ```
   Publié sur npm public (org `@veridian` à créer si pas encore là) ou
   à défaut sur GHCR npm registry privé (`@christ-roy/`). Au choix de
   l'agent — préférence npm public car les sites client ne sont pas tous
   sur l'org Christ-Roy.

### L2 — Endpoint ingestion confirmé en prod (P0)

Smoke test depuis `veridian.site` prod :

```bash
curl -X POST https://analytics-engine.app.veridian.site/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"site_id":"vrd_test","event":"pageview","path":"/","visitor_id":"test","utm":{"source":"smoke"}}'
# → 200 OK attendu
```

⚠️ **Bug repéré** : ce matin (2026-06-02) `analytics-engine.app.veridian.site → 404`
au healthcheck Traefik (infra status). Le container engine prod est
`Up [starting]` mais Traefik ne route pas. **À fixer avant tout déploiement
SDK** — sans engine prod opérationnel, aucun client ne peut tracker.

→ Investiguer labels Traefik dans le compose Dokploy
`analytics-engine-prod-gkggyk` + healthcheck endpoint.

### L3 — Husky pre-push adapté (P1)

Le pre-push actuel doit autoriser les pushes qui touchent **uniquement**
le dossier `sdk/` sans déclencher la totalité du gate (Vitest engine +
E2E Playwright bridge) qui n'ont rien à voir avec le SDK.

Proposition :
- Détecter `git diff --name-only ORIGIN..HEAD | grep -qE "^sdk/"` →
  bypass des tests engine/bridge, exécuter SEULEMENT `cd sdk && pnpm test`
- Maintenir le gate complet si le diff touche `api/`, `console/`,
  `veridian-bridge/`

Pas de `--no-verify` autorisé. Si le SDK ne passe pas son propre test, on
ne push pas.

### L4 — Doc d'install minimale pour intégrateur (P1)

Mettre à jour `sdk/README.md` avec :

1. **Quickstart snippet** (2 lignes à coller dans `<head>`)
2. **Quickstart npm** (1 commande + 1 init)
3. **API minimum tunnel de vente** :
   - `track('pageview')` — automatique au load
   - `identify(email)` — appelé au form submit / signup
   - `track('form_submission', {form: 'contact'})` — events custom
   - UTM capturés automatiquement depuis `window.location.search`
   - `visitor_id` posé en cookie 1st party 13 mois (déclenche ePrivacy
     uniquement si catégorie "Analytics" du consent banner OK)
4. **Endpoint debug** : URL d'un dashboard staging où l'intégrateur voit
   ses events arriver en temps réel (live view staminads native)
5. **CSP & SRI** : hash SRI à fournir pour le snippet, exemple de
   directive CSP (`script-src 'self' analytics-engine.app.veridian.site`)

### L5 — Audit du sdk-api-analysis-report.md (P1)

Le rapport du 2026-01-08 identifie **3 bugs CRITICAL** dans le mapping
SDK→API :
- Issue 1 : pageview `entered_at`/`exited_at` non stockés côté API
- (Issues 2 et 3 — à relire dans le rapport)

→ Trancher : déjà résolus ? Encore présents ? Si encore là, **bloquant
livraison** parce qu'on perd des données du tunnel de vente. Vérifier
puis fixer ou marquer obsolète.

## Compatibilité tunnel de vente

Le SDK DOIT couvrir nativement ces besoins (cf `TUNNEL-DE-VENTE.md` §2 et §6) :

| Besoin | API SDK requise |
|---|---|
| Tracking anonyme avec `visitor_id` persistant | Cookie 1st party 13 mois, regen si effacé |
| UTM auto depuis URL | Captés au chargement, stockés en session pour propager sur events |
| Identification (visitor_id ↔ email) | `tracker.identify(email)` |
| Events form / RDV / interaction | `tracker.track(eventName, props)` |
| Gated consent | Ne pose le cookie + ne ping l'API QUE si catégorie "Analytics"
| | du banner = `granted`. Écoute event `consent-changed`. |
| Anti-cassage site | Async, defer, jamais bloquant render, fallback silencieux 4xx/5xx |

## Workflow de livraison attendu

1. Fix Traefik 404 prod engine (L2)
2. Adapter husky (L3) pour pouvoir bosser sereinement
3. Audit + fix les 3 bugs SDK↔API (L5)
4. Build SDK + publish (L1)
5. Doc README (L4)
6. **Smoke prod** : appeler depuis le compose prod un curl POST `/api/ingest`
   et vérifier que l'event apparaît dans le dashboard ClickHouse
7. Push une release tag `sdk-v1.0.0` sur le repo
8. Notifier le repo `veridian-site` (ticket
   `2026-06-02-cabler-tracker-engine.md`) que le SDK est dispo

## Risques

- **Données client legacy** : 5 clients existants (`avse-monetique`,
  `morel-volailles`, `robert-deboucheur`, `tramtech-depannage`,
  `arnaudcapitaine`) tournent encore sur le tracker home-made du repo
  legacy `veridian-analytics`. Ne PAS casser leur tracking en touchant
  les endpoints `/api/ingest` engine. Dual-tracking pendant 30j minimum
  comme prévu dans le ticket migration `D2-migrate-5-clients.md`.
- **CSP du site client** : un client avec une CSP stricte refusera de
  charger un `<script src>` externe non whitelisté. La doc doit expliciter.
- **GDPR/ePrivacy** : ne JAMAIS poser le cookie `visitor_id` avant
  consentement. C'est un cookie de tracking, pas un cookie technique.

## Quand est-ce fini ?

- [ ] `https://analytics-engine.app.veridian.site/` → 200
- [ ] `curl POST /api/ingest` depuis l'extérieur → 200 + event visible
      dans le dashboard ClickHouse
- [ ] `https://analytics-engine.app.veridian.site/sdk/v1/tracker.js` →
      200, MIME `application/javascript`, taille < 30 KB gzip
- [ ] `pnpm add @veridian/analytics-tracker` marche depuis un projet
      Next.js externe (à tester depuis demo-sdk OU directement depuis
      `veridian-site`)
- [ ] `sdk/README.md` à jour avec les 5 sections ci-dessus
- [ ] Husky pre-push adapté, push d'une PR qui touche que `sdk/` passe
      en < 1 min (au lieu de 8 min full gate)
- [ ] Smoke prod OK depuis le ticket `veridian-site` (pageview arrive)

## Notes pour l'agent

- Le SDK existe déjà → tu **rationalises et publies**, tu ne réécris
  pas. Si tu trouves du code mort dans `sdk/src/` qui n'est pas dans le
  scope tunnel, dégage ou marque deprecated.
- Robert veut "boucler pour deploy prod" — vise la **chaîne complète
  jusqu'à veridian.site qui ping l'engine prod**, pas un SDK orphelin
  parfait.
- Ne touche pas au repo `veridian-site` toi-même : envoie le ticket
  cousin (déjà déposé : `veridian-site/todo/2026-06-02-cabler-tracker-engine.md`).
