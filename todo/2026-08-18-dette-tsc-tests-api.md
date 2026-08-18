# [ENGINE] Dette `tsc` dans les tests de `api/` — 261 erreurs, zéro dans le code de prod

> **Sévérité** : 🟡 P2. Aucun risque produit direct (voir §1), mais le
> typecheck de l'engine ne veut plus rien dire, et un `check-engine-api.sh`
> qui ne peut pas s'appuyer dessus laisse passer la classe de bugs qu'il a
> justement été écrit pour attraper.
> **Créé** : 2026-08-18, en marge de la mission d'hygiène du dépôt
> **Mesuré sur** : `origin/main` @ `9b264f0`, `cd api && npx tsc --noEmit`

---

## 1. Le chiffre qui commande la priorité

261 lignes `error TS`. Leur répartition change tout :

| Emplacement | Erreurs | Nature |
|---|---:|---|
| `test/**/*.e2e-spec.ts` | **217** | e2e Jest |
| `src/**/*.spec.ts` | 43 | tests unitaires colocalisés |
| `scripts/` | 1 | `generate-openapi.ts` |
| **`src/` hors specs (code de production)** | **0** | — |

**Le code de production typecheck proprement.** C'est la première chose à
savoir : ce n'est pas un incendie, c'est de la dette d'outillage de test. Ne
pas le traiter comme une urgence prod, et ne pas non plus le laisser pourrir.

Concentration forte, ce qui rend le chantier abordable : **147 des 217
erreurs `test/` tiennent dans 3 fichiers.**

| Fichier | Erreurs |
|---|---:|
| `test/page-tracking.e2e-spec.ts` | 84 |
| `test/backfill.e2e-spec.ts` | 37 |
| `test/user-id-export.e2e-spec.ts` | 26 |
| `test/members.e2e-spec.ts` | 14 |
| `test/session-payload.e2e-spec.ts` | 13 |
| `test/api-keys.e2e-spec.ts` | 13 |

## 2. Trois familles, et une seule cause pour les deux tiers

| Code | Nb | Sens |
|---|---:|---|
| `TS2339` | 101 | Property does not exist on type |
| `TS2571` | 57 | Object is of type `unknown` |
| `TS18046` | 55 | `X` is of type `unknown` |
| `TS2322` / `TS2353` / `TS2345` | 28 | types de littéraux d'objet désalignés |
| divers | 20 | `TS7053`, `TS2493`, `TS2352`, `TS2739`… |

`TS2571` + `TS18046` + une bonne part de `TS2339`, soit **~210 erreurs, sont
le même geste** : `response.body` de supertest est typé `unknown` depuis une
montée de `@types/supertest` / `superagent`, et les tests l'utilisent sans
l'annoter.

```ts
// aujourd'hui — res.body: unknown
expect(res.body.workspace_id).toBe(...)   // TS18046 puis TS2339
```

Le correctif est mécanique et sans risque : typer la réponse au point
d'appel, une fois par requête.

```ts
const res = await request(app).get('/api/…').expect(200);
const body = res.body as { workspace_id: string; /* … */ };
expect(body.workspace_id).toBe(...);
```

Le reste (`TS2322`, `TS2353`, `TS2739`, `TS2352`) est une vraie
désynchronisation entre les fixtures de test et les types du produit :
`AnalyticsResponse`, `TrackingEvent` (il manque `page_duration`,
`visitor_id`, `fingerprint`… soit 14 champs), `ApiKeyPayload`. Ceux-là
demandent de lire le type courant et de corriger la fixture — c'est là que se
cache l'intérêt réel du chantier, parce qu'une fixture périmée est un test
qui vérifie un produit qui n'existe plus.

## 3. Pourquoi `check-engine-api.sh` ne les voit pas

Trois raisons cumulées, toutes dans l'en-tête du script :

1. Il ne fait un `tsc` que **si `api/node_modules` existe déjà** — il
   n'installe rien (règle no-build-local, machine à RAM contrainte). Sur un
   poste ou un runner sans `node_modules`, l'étape saute entièrement.
2. Ce `tsc` est **incrémental** (`skipLibCheck` + `incremental`) : il ne
   repart pas d'un état propre.
3. Il **ne se déclenche que si le diff touche `api/src/**/*.ts`**, en
   excluant les `.spec.ts`. Or 217 des 261 erreurs sont sous `test/`, chemin
   que le script ne regarde jamais.

Ajouté le 2026-08-18 : le script retombait aussi sur `HEAD~1` en silence
quand sa base était introuvable, ce qui le faisait conclure « aucun fichier
api/src touché » sur des pushs qui en touchaient. Corrigé (il échoue
bruyamment), mais ça a contribué à masquer la situation.

## 4. Ce que je propose

Découpage en trois lots indépendants, parallélisables sur trois agents :

- **Lot A — le geste mécanique (~210 erreurs).** Typer `res.body` dans les
  e2e. Commencer par `page-tracking`, `backfill`, `user-id-export` : 147
  erreurs à eux trois. Aucun risque, aucune décision. ~1 agent.
- **Lot B — les fixtures désynchronisées (~30 erreurs).** `TrackingEvent`,
  `AnalyticsResponse`, `ApiKeyPayload`. Demande de lire les types courants ;
  c'est ici qu'on peut découvrir un test qui ne teste plus rien. ~1 agent.
- **Lot C — le gate.** Une fois A et B verts : faire tourner un `tsc --noEmit`
  complet sur `api/` en CI (pas en pre-push, contrainte RAM), et le rendre
  bloquant. Sans ce lot, A et B se re-dégraderont en quelques semaines.

**L'ordre compte** : C n'a de sens qu'après A et B, sinon le gate est rouge
en permanence et on le désactivera.

## 5. Vérifier l'état à tout moment

```bash
cd api && npx tsc --noEmit 2>&1 | grep -cE 'error TS'          # total
cd api && npx tsc --noEmit 2>&1 | grep -E 'error TS' \
  | grep -E '^src/' | grep -vcE '\.spec\.ts\('                  # code de prod : doit rester 0
```

La seconde commande est l'**anti-régression qui compte** : le jour où elle
sort autre chose que `0`, la dette a franchi la frontière des tests et est
entrée dans le produit.
