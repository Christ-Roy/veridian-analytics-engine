# 🔴 Snippet SDK généré par l'UI pointe vers une URL 404 — tout nouveau client = tracker mort

> **Sévérité** : 🔴 P0 — bloquant onboarding, le cœur du produit (le tracking) ne démarre jamais
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-17
> **Demandeur** : audit-configui (axe config UI ↔ capacités backend)

## Résumé

Les **trois** endroits de la console qui génèrent le snippet `<script>` à coller
chez le client pointent vers une URL que le backend **ne sert pas**. Le bundle
tracker est exclusivement servi par `SdkController` sous `/sdk/v1/tracker.js`,
mais l'UI génère `/sdk/staminads_<version>.min.js` (×2) ou `/sdk/staminads.min.js`
(×1). Résultat : un nouveau client copie le snippet d'onboarding, le colle, et
le `<script>` renvoie **404** → aucun événement n'est jamais tracké.

C'est la pire incohérence config UI ↔ backend de l'app : la feature n°1 (visiteurs
uniques) est inaccessible dès la première étape pour tout nouveau tenant.

## Preuve (2 bouts)

### Backend — ce qui est RÉELLEMENT servi

`api/src/app.module.ts:57-63` : le static EXCLUT tout `/sdk/*`, qui est donc
100 % géré par le controller.

```ts
ServeStaticModule.forRoot({
  rootPath: join(__dirname, 'public'),
  // `/sdk/*` is owned by SdkController (explicit Cache-Control + CORS).
  exclude: ['/api/{*path}', '/health', '/sdk/{*path}'],
}),
```

`api/src/sdk/sdk.controller.ts:37,47,61,71,85` — `@Controller('sdk/v1')`, les
SEULES routes exposées :

```
GET /sdk/v1/tracker.js        → staminads.min.js (UMD)
GET /sdk/v1/tracker.esm.js
GET /sdk/v1/tracker.d.ts
GET /sdk/v1/manifest.json
```

`Dockerfile:72-74` confirme : le fichier sur disque est
`dist/public/sdk/v1/staminads.min.js`, jamais à la racine `/sdk/` ni avec un
suffixe de version dans le nom.

### UI — ce qui est GÉNÉRÉ (toutes les 3 URLs sont 404)

1. `console/src/routes/_authenticated/workspaces/$workspaceId/install-sdk.tsx:80`
   ```
   <script async src="${window.location.origin}/sdk/staminads_${__APP_VERSION__}.min.js"></script>
   ```
   → `/sdk/staminads_0.5.x.min.js` — **404** (exclu du static, absent du controller)

2. `console/src/routes/_authenticated/workspaces/$workspaceId/settings.tsx:549`
   (onglet « SDK ») — **identique**, même URL versionnée → **404**

3. `console/src/veridian/pages/welcome.tsx:96` (`buildTrackerSnippet`,
   l'onboarding wizard, première impression client) :
   ```
   <script async src="${endpoint}/sdk/staminads.min.js"></script>
   ```
   → `/sdk/staminads.min.js` — **404** (le controller sert `/sdk/v1/tracker.js`)

De plus `console/src/veridian/pages/__tests__/welcome.test.tsx:99` **verrouille**
l'URL cassée (`expect(snippet).toContain('https://example.com/sdk/staminads.min.js')`),
donc le bug est protégé par un test vert.

## Demande précise

1. **Aligner les 3 snippets sur le contrat backend `/sdk/v1/tracker.js`.**
   Remplacer dans les 3 fichiers la balise `<script src>` par :
   ```html
   <script async src="${endpoint}/sdk/v1/tracker.js"></script>
   ```
   (et supprimer la dépendance à `__APP_VERSION__` dans le nom : le versioning
   est porté par le **chemin** `/v1/`, pas par le filename — c'est le design
   explicite documenté dans `sdk.controller.ts:18-21`. Le cache-busting est déjà
   géré par `Cache-Control: max-age=3600` côté controller.)

2. **Centraliser la génération du snippet** : les 3 emplacements dupliquent la
   même string avec des variantes divergentes. Extraire un seul
   `buildTrackerSnippet({ workspaceId, endpoint })` (celui de `welcome.tsx` est
   le plus complet — il porte `trackSPA`/`trackScroll`) et le réutiliser dans
   `install-sdk.tsx` et l'onglet SDK de `settings.tsx`. Une seule source = plus
   jamais de divergence d'URL.

3. **Corriger le test** `welcome.test.tsx:99` pour asserter la bonne URL
   (`/sdk/v1/tracker.js`).

4. (Optionnel mais recommandé) Ajouter un E2E qui `fetch()` réellement l'URL du
   `src` généré et vérifie un `200 + content-type: application/javascript` — un
   snippet généré n'a aucune valeur s'il pointe dans le vide, et c'est exactement
   le genre de régression qu'un test unitaire mock ne voit pas.

## Impact

- **Bloquant onboarding** : chaque nouveau client qui suit le wizard `welcome`
  ou copie le snippet depuis Settings → SDK installe un script mort. Le polling
  « En attente du premier événement » de `install-sdk.tsx` et `welcome.tsx`
  tournera indéfiniment (timeout 60 s) sans jamais détecter d'événement — alors
  que le client a *correctement* posé le snippet. Support garanti + perte de
  confiance dès la première minute.
- **Démo publique** (`demo-analytics.veridian.site`) potentiellement impactée si
  elle réutilise ces snippets pour la promo.
- Réversible et rapide à corriger (3 strings + 1 test). Tier 🟡 MOYEN à
  promouvoir (UI dashboard + contrat URL public, à valider sur staging par un
  vrai `curl` de l'URL générée).
