# Démo publique Veridian Analytics

> URL : <https://demo-analytics.veridian.site>
> Livré : ticket E1 (giga-sprint 2026-05-22)

Instance publique en lecture seule de Veridian Analytics. N'importe qui
(prospect, lead, curieux) peut voir un workspace pré-rempli avec 200 000
sessions sur 90 jours **sans login**. Objectif : convertir des prospects qui
veulent voir l'app avant de signer.

---

## 1. Architecture

```
                  ┌─────────────────────────────────────────┐
  visiteur  ──TLS─▶ Traefik (Dokploy)  Host=demo-analytics…  │
                  │   + ratelimit 60/min/IP                  │
                  └───────────────┬─────────────────────────┘
                                  ▼
              ┌───────────────────────────────────┐
              │ engine (NestJS + console)          │
              │  IS_DEMO=true                      │
              │  - /api/demo.login  (auto-login)   │
              │  - /api/public-config              │
              │  - /api/health                     │
              │  - écritures bloquées (Guard)      │
              └───────────────┬───────────────────┘
                              ▼
              ┌───────────────────────────────────┐
              │ clickhouse (DÉDIÉ — jamais prod)   │
              │  re-seed destructif chaque nuit    │
              └───────────────────────────────────┘
```

Pas de bridge, pas de Postgres : la démo ne sert que le frontend + l'API
publique staminads. Le bridge (couche Hub) n'a pas vocation à être public.

### Comment ça marche, côté code

| Brique | Fichier | Rôle |
|---|---|---|
| `IS_DEMO=true` | ENV | Active le mode démo (écritures bloquées + branding) |
| `DemoRestrictedGuard` | `api/src/common/guards/demo-restricted.guard.ts` | Renvoie 400 sur tout endpoint `@DemoRestricted()` |
| `POST /api/demo.login` | `api/src/demo/demo.controller.ts` | Auto-login anonyme — mint un JWT pour `demo@veridian.site` |
| `GET /api/public-config` | idem | Le SPA poll au boot pour détecter le mode démo |
| `GET /api/health` | `api/src/health/health.controller.ts` | Liveness probe (Traefik + cron + monitoring) |
| `DemoService` | `api/src/demo/demo.service.ts` | `generate()` seed 200k sessions, crée user + workspace |
| `DemoBanner` / `DemoFooter` | `console/src/veridian/demo-*.tsx` | Bandeau + footer marketing (gated `is_demo`) |
| `applyDemoBranding()` | `console/src/lib/demo-config.ts` | Title + favicon Veridian au runtime |

Le bundle frontend est **construit une seule fois** et embarqué dans toutes
les images (prod, staging, démo). Il ne peut pas savoir au build s'il tourne
en mode démo → il interroge `GET /api/public-config` au démarrage.

---

## 2. Déploiement (Dokploy prod)

Compose : `compose/demo.yml` (standalone, ne PAS combiner avec `base.yml`).

```bash
docker compose -f compose/demo.yml up -d
```

### ENV requis (panneau Dokploy)

| Variable | Source |
|---|---|
| `ENGINE_IMAGE_TAG` | tag GHCR, ex `veridian-latest` ou `staging-<sha7>` |
| `CLICKHOUSE_PASSWORD` | `ANALYTICS_DEMO_CLICKHOUSE_PASSWORD` (all-creds.env) |
| `ENCRYPTION_KEY` | `ANALYTICS_DEMO_ENCRYPTION_KEY` (all-creds.env) |
| `DEMO_SECRET` | `DEMO_SECRET_ANALYTICS` (all-creds.env) |

### DNS

`demo-analytics.veridian.site` → A/CNAME proxied Cloudflare vers l'IP du
serveur Dokploy prod. Cert Let's Encrypt automatique via le resolver
`letsencrypt` de Traefik (label dans `compose/demo.yml`).

---

## 3. Premier seed

Une fois le stack up et le DNS résolu :

```bash
DEMO_SECRET=$(grep '^DEMO_SECRET_ANALYTICS=' ~/credentials/.all-creds.env | cut -d= -f2)
curl -X POST "https://demo-analytics.veridian.site/api/demo.generate?secret=${DEMO_SECRET}"
```

Durée ~5-10 min (200k sessions × 90 jours). Le seed crée aussi l'utilisateur
`demo@veridian.site` et marque `setup_completed=true` (sinon le SPA renvoie
vers `/setup`).

Vérif : <https://demo-analytics.veridian.site> doit afficher le workspace
`Veridian Analytics Demo` après auto-login.

---

## 4. Re-seed quotidien (cron)

Le workspace doit rester "actuel" (sinon les dates glissent). Cron systemd
sur **dev-pub**, daily 03:00 UTC.

### Installation (sur dev-pub)

```bash
ssh dev-pub
cd <repo>/scripts/demo
./install-reseed-cron.sh
sudo nano /etc/veridian/demo-reseed.env   # renseigner DEMO_SECRET
sudo systemctl restart reseed-demo.timer
```

### Re-seed manuel

```bash
sudo systemctl start reseed-demo.service   # sur dev-pub
journalctl -u reseed-demo -f               # suivre le résultat
```

Le script (`scripts/demo/reseed-demo.sh`) : health check → `demo.delete` →
`demo.generate` → health check final. Échec → alerte Telegram si
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` sont configurés dans l'EnvironmentFile.

---

## 5. Sécurité

- **Écritures bloquées** : `DemoRestrictedGuard` sur signup, billing, password
  reset, `workspaces.create/update/delete`, API keys, members, invitations,
  SMTP, filters. Couvert par `api/test/demo-mode.e2e-spec.ts`.
- **Rate limit** : 60 req/min/IP (burst 120) via middleware Traefik dans
  `compose/demo.yml`.
- **HTTPS only** : redirect HTTP→HTTPS via Traefik.
- **Pas de bridge exposé** : `compose/demo.yml` ne ship que engine +
  clickhouse.
- **`robots.txt`** : `console/public/robots.txt` autorise l'indexation de la
  page d'accueil, interdit `/workspaces` (dates fictives) et `/api/`.
- **Pas de mention `staminads`** dans les meta : `applyDemoBranding()` réécrit
  le `<title>` en "Veridian Analytics" au runtime.
- **`DemoSecretGuard`** : `demo.generate` / `demo.delete` protégés par
  comparaison timing-safe du query param `secret` vs `DEMO_SECRET`.

---

## 6. Changer le branding (V2)

- **Logo** : `console/public/veridian-logo.svg` (wordmark + mark bleu).
- **Nom du workspace** : constante `DEMO_WORKSPACE_NAME` dans
  `api/src/demo/demo.service.ts`.
- **Bandeau / footer** : `console/src/veridian/demo-banner.tsx` et
  `demo-footer.tsx` (CTA `mailto:`).
- **Title / favicon** : `applyDemoBranding()` dans
  `console/src/lib/demo-config.ts`.

Tout le branding démo est gated sur `is_demo` — la console interne et le
staging ne sont jamais impactés.

---

## 7. Où trouver le secret

`~/credentials/.all-creds.env` :

```
DEMO_SECRET_ANALYTICS=...
ANALYTICS_DEMO_ENCRYPTION_KEY=...
ANALYTICS_DEMO_CLICKHOUSE_PASSWORD=...
ANALYTICS_DEMO_URL=https://demo-analytics.veridian.site
```
