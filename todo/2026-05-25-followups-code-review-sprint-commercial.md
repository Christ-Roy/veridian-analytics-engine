# Follow-up code-review sprint commercial 2026-05-25

> **Sévérité globale** : 🟡 P1
> **Origine** : code-review high des 4 PRs mergées 2026-05-25 (#29 sécu setup, #32 FR drawer, #33 helmet, #35 phone-source)
> **Rapport complet** : `/tmp/code-review-2026-05-25.md` (254 lignes)
> **Risque prod actuel** : 3/10 — prod safe, ces follow-ups sont des durcissements pas des rollbacks

## Contexte

Sprint commercial 2026-05-25 a livré 4 PRs (sécu /setup, FR drawer, helmet, phone-source) toutes mergées + déployées en prod. Code-review effort `high` a identifié 0 bloquant mais 3 actions follow-up prioritaires + 1 dette transverse.

## Top 3 actions prioritaires

### 1. 🟡 Server-side guard sur `/setup` (durcissement P0 sécu)

**Problème** : Le fix PR #29 ajoute un guard React fail-closed côté frontend, MAIS `curl https://analytics-engine.app.veridian.site/setup` retourne toujours HTTP 200 avec le shell SPA. C'est défense JavaScript only, pas défense réseau.

**Risque réel** : faible (form bootstrap dans un JS chunk, pas dans le HTML servi) mais :
- URL accessible publiquement → indexable par moteurs
- Attacker headless avec mock `/api/setup.status` peut accéder au form

**Fix proposé** : ajouter un middleware NestJS qui retourne `302 /login` sur la route `/setup` quand `isSetupComplete()` est `true`. Vrai fail-closed côté serveur. Frontend devient defense-in-depth secondaire.

**Fichier** : créer `api/src/setup/setup-redirect.middleware.ts` (à appliquer dans `app.module.ts` sur le path `/setup`).

**Test à ajouter** : update `tests/e2e/21-anti-regression-2026-05-25/setup-locked.spec.ts` pour vérifier `expect(response.status()).toBe(302)` ET `expect(response.headers().location).toContain('/login')`.

---

### 2. 🟡 Rate-limit explicite sur `POST /api/setup.initialize`

**Problème** : L'endpoint reste `@Public()` (cohérent — sinon impossible de bootstrap). Le `ThrottlerModule` global a `auth: ttl 60s, limit 10` mais l'endpoint `setup.initialize` n'est pas catégorisé.

**Risque** : si le flag setup est reset accidentellement, un attacker peut spam des tentatives.

**Fix** : ajouter `@Throttle({ default: { limit: 3, ttl: 60_000 } })` sur la méthode `initialize()` du `SetupController`.

---

### 3. 🟡 UI feedback sur DELETE phone-number qui fail

**Problème** : `console/src/veridian/settings-panels/voip-panel.tsx:340-347` — DELETE swallow l'erreur silencieusement. Si l'API renvoie 500/403, le bouton corbeille fait `nothing visible`, la row reste sans explication.

**Fix** : afficher un toast d'erreur via `App.useApp()` (Ant Design pattern utilisé ailleurs dans staminads). Retirer le commentaire trompeur "l'erreur s'affiche au prochain reload".

```tsx
onDelete={async (row) => {
  try {
    await deletePhoneNumber(workspaceId, row.id);
    load();
    notification.success({ message: 'Numéro supprimé' });
  } catch (err) {
    notification.error({
      message: 'Suppression impossible',
      description: err instanceof Error ? err.message : 'Erreur inconnue',
    });
  }
}}
```

---

### 4. 🟡 Vérifier en staging que la CSP ne casse pas le mode Live (WebSockets)

**Problème** : PR #33 CSP `connect-src 'self'` ne couvre PAS `wss:` / `ws:`. Si la console utilise des WebSockets pour le mode Live (real-time visitors), la CSP les bloquera.

**Action immédiate** : `grep -rn "WebSocket\|ws://\|wss://\|EventSource" console/src/` côté engine pour vérifier. Si utilisé, ajouter `'ws:' 'wss:'` ou `${origin}` au `connect-src`.

**Action surveillance** : prochain run nightly du workflow `e2e-security-audit.yml` doit confirmer que les tests headers passent.

---

## Dette transverse à traiter en sprint suivant

### 🚨 `VITE_VERIDIAN_ADMIN_KEY` exposée au bundle Vite (dette pré-existante)

**Périmètre** : depuis avant le sprint 2026-05-25. PR #35 phone-source **étend la surface** : CRUD phone-numbers désormais accessible avec ce token côté browser.

**Risque** : un token admin exposé dans le JS bundle = lisible par tout client qui ouvre l'app. Tout XSS, tout user qui inspect le bundle, tout share screen peut leaker.

**Fix proposé V2** : migrer toutes les routes admin Bearer-protégées (cf `/api/admin/tenant/:wsId/*` + nouvelles `/api/admin/tenant/:wsId/phone-numbers/*`) vers une auth par **session JWT staminads** (pattern déjà utilisé pour les autres routes user) OU vers une **proxy route engine** qui forward avec le secret côté serveur.

**Pourquoi pas tout de suite** : refactor multi-fichier touchant l'auth pattern, demande un sprint dédié. Mais à graver dans le backlog parce que la surface s'étend.

**Ticket dédié à créer** : `todo/2026-MM-DD-migrate-vite-admin-key-to-session-auth.md`

---

## Autres findings non-prioritaires (cf rapport complet)

- **Timeouts explicites sur fetch** (setup-guard, voip API) — UX dégradée en cas réseau lent. Pattern à durcir.
- **500 leak `err.message`** (phone-numbers.routes.ts) — bad practice transverse, à fix.
- **CSP `crossOriginEmbedderPolicy: false`** — désactive isolation cross-origin, pas un risque sécu direct.
- **HSTS maxAge 180j** au lieu de 1 an (standard) — suffisant V1.
- **`toE164()` ne gère pas extension SIP** (`;ext=42`) — silently fallback `direct`. Test unitaire à ajouter pour verrouiller.
- **DIMENSION_LABELS** dupliqué entre `goals/` et `subscription/` — incohérence i18n. Centraliser dans un constant partagé.

---

## Patterns positifs à conserver

1. **Defense-in-depth systématique** sur les 4 PRs
2. **Tests intégration qui mirror le wiring prod** (harness commun)
3. **Documentation inline du "pourquoi"** (rationale des CSP directives, commentaires multi-lignes sur les fix sécu)
4. **Retrait du `|| true` workflow CI** (PR #33) — courageux et nécessaire
5. **Migration additive pure** (PR #35) — pas de mutation de colonnes existantes
6. **Lockfile regen séparé** après ajout dep (PR #33 `81a835f`) — pattern à généraliser
