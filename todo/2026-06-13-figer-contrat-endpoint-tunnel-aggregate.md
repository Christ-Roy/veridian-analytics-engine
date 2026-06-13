# Figer le contrat `GET /api/tunnel.aggregate` (source agrégat du scoring bridge)

> **Sévérité** : 🔴 P0 (gate de l'E2E #3 et du débranchement #4)
> **Owner** : agent twenty-connector (porte tasks #2 + #5, worktree engine)
> **Créé** : 2026-06-13
> **Déposé par** : agent decommission (Task #4)
> **Runbook source** : `docs/RUNBOOK-DECOMMISSION-TUNNEL-PUSH.md` §0, §2bis, §5
> **Décision** : Option A figée par le team-lead 2026-06-13

---

## Pourquoi ce ticket

Le débranchement du push analytics→Twenty du micro-service tunnel (Task #4)
repose sur l'**Option A** : l'engine **ne PATCH jamais `person.score`**. Le
bridge reste seule autorité du score ; il cesse juste de **pull**
`export.userEvents` et lit à la place un **endpoint d'agrégats analytics** que tu
livres en Task #5.

➡️ Ce contrat d'endpoint doit être **figé dans `CONTRATS-TUNNEL.md` §7 AVANT**
l'E2E #3, sinon le bridge ne peut pas brancher sa nouvelle source et la parité
(§5 P3a/P3b du runbook) ne peut pas être prouvée.

---

## Le contrat à figer

**Endpoint** : `GET /api/tunnel.aggregate`

- **Auth** : JWT super-admin engine (même `auth.login` programmatique que le pull
  actuel — pas d'API key sur workspace platform-managed, 403 vérifié 2026-06-10).
- **Query** : `workspace_id` (`vrd_veridian_site_prod`), `since`/`until`
  (fenêtre, défaut 48h pour coller au curseur bridge actuel), pagination cursor.
- **Réponse** : un item **par identité** (`user_id` = slug audit OU email
  normalisé), shape **strictement identique** à l'interface `AnalyticsAggregate`
  consommée par `score-tunnel.ts` du bridge :

```ts
{
  userId: string;          // slug audit OU email normalisé (union des 2 clés)
  auditViews: number;
  auditScrollMax: number;  // 0-100
  hotPages: number;        // /tarifs, /contact, /roi (uniques)
  otherPages: number;      // hors audit + hors chaudes (uniques)
  consented: boolean;      // tracké, ne score JAMAIS (décision lead)
  ctaClicks: number;
  rdvBooked: number;
  identifiedByEmail: boolean;
  appStarted: boolean;     // goal Hub notifuse/prospection (whitelist §4a-bis)
  sessions: number;
  lastSeen: string | null; // ISO 8601 (le bridge parse en Date)
}
```

- **Sémantique d'agrégation** = **exactement** celle de
  `veridian-tunnel-de-vente/bridge/src/analytics-pull.ts:aggregateEvents`
  (référence SCORING-V1.md §3) : `HOT_PATHS` = {/tarifs, /contact, /roi},
  mapping des goals `audit.*` / `signup` / `app_started`, whitelist
  `APP_STARTED_SCORED_APPS` = {notifuse, prospection}, `consent_granted` = 0
  point. **Tout écart = écart de score → bloquant en parité.**

---

## Ce que tu NE fais PAS (Option A)

- ❌ **Ne calcule PAS le score** dans l'engine (pas de `computeTunnelScore`).
- ❌ **Ne PATCH JAMAIS `person.score`** dans Twenty. L'engine n'écrit que la
  timeline `audit.*` (Task #2) ; le score reste 100% côté bridge.
- ❌ Ne consomme PAS les signaux Notifuse (l'engine n'a pas cette data, et ne
  doit pas l'avoir — couplage interdit). Le bridge fusionne
  Notifuse + cet agrégat de son côté.

L'endpoint sert **uniquement** l'agrégat analytics brut par identité. Le bridge
garde `mergeAggregates` (fusion slug↔email via links.json) +
`computeTunnelScore` + le writer + le CAS exactly-once `markScorePushed`.

---

## Critère d'acceptation

- `GET /api/tunnel.aggregate?workspace_id=…&since=…&until=…` renvoie des items au
  format ci-dessus, paginés.
- **Test de parité** : pour une même fenêtre, l'agrégat servi == l'agrégat
  produit par `aggregateEvents` du pull bridge (item par item, champ par champ) —
  0 écart. C'est le critère P3a du runbook.
- Contrat écrit dans `CONTRATS-TUNNEL.md` §7 (nouveau bloc « endpoint agrégat »).
- Multi-tenant : un appel ne renvoie que les identités du `workspace_id` demandé.

## Coordination

Le bridge consomme cet endpoint (ticket
`veridian-tunnel-de-vente/todo/2026-06-13-debrancher-push-analytics-twenty.md`).
Toute évolution de la shape doit être répercutée des deux côtés via le contrat
§7. Question/blocage → réponds ici (`## Réponse — YYYY-MM-DD`) + team-lead.
