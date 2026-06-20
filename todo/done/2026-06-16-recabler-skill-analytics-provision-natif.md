# Recâbler le skill `analytics-provision` sur le contrat NATIF M2M (tuer le legacy x-admin-key)

> **Sévérité** : 🟡 P1 (+ 🔴 P0 sécu : clé admin en clair dans le skill, cf §Sécu)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-16
> **Déposé par** : agent `cross-tickets` (sprint decommission bridge/legacy)
> **Ticket parent** : `veridian-analytics/todo/2026-06-15-GIGA-decommission-bridge-workaround-legacy.md` (Lot A)

---

## Contexte

Le skill `~/.claude/skills/analytics-provision/SKILL.md` est **100 % écrit contre
le legacy** :
- Base `https://analytics.app.veridian.site` (legacy Next.js, condamné, déjà
  UNHEALTHY/404 en prod au 2026-06-16).
- Header `x-admin-key` partout (`/api/admin/tenants`, `/api/admin/sites`,
  `/api/admin/gsc/sync`, etc.).

C'est aujourd'hui le **chemin de provisioning analytique réellement utilisé**
(le client Hub `lib/analytics/client.ts` n'a pas d'ENV analytics configurée en
prod — vérifié, donc côté Hub le provisioning n'est pas opérationnel). Donc tant
que ce skill tape le legacy, on ne peut pas décommissionner le legacy.

Le contrat propre existe côté engine (`docs/PLATFORM-ADMIN-API.md`) :
- `POST /api/admin/platform/tenants.provision` (Bearer `PLATFORM_ADMIN_API_KEY`)
  → workspace + owner user + API key + magic-link en un call.
- `POST /api/admin/platform/workspaces.provisionApiKey`.
- Vérifié prod 2026-06-16 : `tenants.provision` → 401 sans Bearer (= câblé).

## 🔴 Sécurité — URGENT (indépendant du recâblage)

Le SKILL.md contient la **clé admin legacy EN CLAIR** :
- ligne ~65 : `ADMIN_API_KEY="+IoQ4ji6rB7EpyhOcO8tht6thHHOXo0H8BrA/co9KXE="`
- ligne ~71 : `x-admin-key: +IoQ4ji6rB7EpyhOcO8tht6thHHOXo0H8BrA/co9KXE=`

→ Un secret de prod ne doit JAMAIS être en clair dans un fichier skill.
**Actions** (à valider Robert) :
1. Révoquer / rotater cette clé legacy (de toute façon le legacy meurt).
2. Remplacer dans le skill par une référence `~/credentials/.all-creds.env`
   (`$ANALYTICS_ADMIN_KEY` ou le nouveau `$PLATFORM_ADMIN_API_KEY`), jamais la
   valeur en dur.

> ⚠️ Le skill est dans `~/.claude/skills/` (hors repo, partagé global). Modif à
> coordonner avec Robert — ce ticket NOTE la demande, Robert valide avant édition.

## Recâblage demandé (vers le natif)

Réécrire le skill pour que toute provision passe par le natif M2M :

1. **Base URL** : `https://analytics-engine.app.veridian.site` (prod),
   `https://analytics-engine.staging.veridian.site` (staging). Plus jamais
   `analytics.app.veridian.site`.
2. **Auth** : `Authorization: Bearer $PLATFORM_ADMIN_API_KEY` (depuis
   `.all-creds.env`), plus de `x-admin-key`.
3. **Provision tenant** : un seul `POST /api/admin/platform/tenants.provision`
   remplace la cascade tenant+site. Payload + réponse documentés dans
   `docs/PLATFORM-ADMIN-API.md`.
4. **Clé API workspace existant** : `POST /api/admin/platform/workspaces.provisionApiKey`.
5. **GSC** : ⚠️ pas d'équivalent natif aujourd'hui (encore dans le bridge, Lot C en
   décision). NE PAS documenter un endpoint GSC natif tant que Lot C n'a pas
   tranché. Marquer la section GSC du skill comme "en migration, cf Lot C".
6. **Snippet tracker** : le natif retourne `snippet_html` directement → simplifier
   la section "génération snippet" du skill (plus de construction manuelle).
7. Mettre à jour les statuts d'env (lignes "Prod | analytics.app.veridian.site |
   ✅ Actif") : remplacer par l'engine, marquer le legacy comme décommissionné.

## Impact

- Sans ce recâblage : impossible de décommissionner le legacy (Lot D) — le skill
  est l'unique chemin de provisioning réel et il tape le legacy.
- **Ordre** : Lot A (ce ticket + ticket Hub) → puis Lot D (couper legacy).

## DoD

- [ ] Clé admin en clair retirée du skill + rotée (sécu, prioritaire).
- [ ] Skill recâblé sur `analytics-engine.app.veridian.site` + Bearer
      `PLATFORM_ADMIN_API_KEY`.
- [ ] Provision = un seul call `tenants.provision`.
- [ ] Section GSC marquée "en migration" (pas de faux endpoint natif).
- [ ] Testé : un provisioning de bout en bout via le skill recâblé (staging).
- [ ] GIGA Lot A coché.
