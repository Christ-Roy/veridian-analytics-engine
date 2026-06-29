# VoIP OVH — attribution fine par numéro réel + consumer key scopé

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-26
> **Demandeur** : Robert (via agent veridian-site)
> **Workspace réel impacté** : `vrd_veridian_site_prod` (déjà branché OVH en prod le 2026-06-26)

## Contexte

Le tracking d'appels VoIP OVH natif (`api/src/voip/`) a été **branché en prod** sur
le workspace Veridian (`vrd_veridian_site_prod`) le 2026-06-26 :
creds OVH posés, `voip:cred-test` OK, numéro `+33482530745` mappé `source=direct`,
`voip:sync` → 6 events `phone_call` poussés dans ClickHouse. **Ça marche.**

MAIS le test grandeur nature a révélé **deux défauts de conception** qui empêchent
de livrer ça à un vrai client. Ce ticket les corrige pour en faire une feature
propre, multi-tenant, et sécurisée.

## Problème 1 — Mauvais champ CDR : on attribue sur la patte de transfert, pas sur le numéro composé

### Symptôme observé en prod

Le workspace Veridian ne possède QUE le numéro `0033482530745`. Or les events
`phone_call` remontés portent comme `to_number` :
- `0033437374021` (5 appels) — **n'appartient pas à Veridian**
- `0033629454311` (1 appel) — c'est le **mobile de renvoi** de Robert

Le numéro OVH réel (`0033482530745`) n'apparaît dans AUCUN event → le lookup
`e164 → source` (`voip-sync.service.ts:128-133`) échoue systématiquement →
tout tombe en fallback `source=direct` + `source_attributed='false'`.

### Cause racine

Les lignes OVH de Robert ont un **renvoi d'appel** (forward) configuré : un appel
entrant sur le numéro OVH est immédiatement transféré vers un mobile. L'API OVH
`voiceConsumption` renvoie alors un CDR de type `wayType: "transfer"` où :

| champ OVH | valeur | signification |
|---|---|---|
| `calling` | `0033626041350` | **le vrai appelant** ✅ |
| `dialed` | `0033482530745` | **le numéro OVH réellement composé** ✅ (= ce qu'on veut matcher) |
| `called` | `0033629454311` | la **patte de transfert** (mobile de destination du renvoi) ❌ |

Le connecteur actuel (`api/src/voip/providers/ovh.ts:212-213`) fait :
```ts
fromNumber: c.calling ?? '',
toNumber:   c.called ?? '',   // ❌ patte de transfert, pas le numéro composé
```
et **ne lit jamais `dialed`** (le type `OvhVoiceConsumption` ne déclare même pas le
champ, cf `ovh.ts:64-72`).

### CDR brut de référence (appel prospect réel, 24 juin 16:37)

```json
{
  "consumptionId": 17947780218,
  "wayType": "transfer",
  "calling": "0033626041350",
  "dialed":  "0033482530745",
  "called":  "0033629454311",
  "duration": 0,
  "creationDatetime": "2026-06-24T16:37:11+02:00"
}
```

### Fix attendu

1. **Déclarer `dialed`** dans le type `OvhVoiceConsumption` (`ovh.ts:64-72`).
2. **Mapper `toNumber` sur le numéro composé d'origine**, pas la patte de transfert :
   ```ts
   // Sur un wayType='transfer' (renvoi d'appel), `called` = destination du
   // transfert (mobile perso), pas le numéro OVH composé. `dialed` porte le
   // numéro réellement appelé → c'est lui qu'il faut matcher au mapping source.
   toNumber: c.dialed ?? c.called ?? '',
   ```
   Garder `c.called` en fallback pour les CDR sans renvoi (où `dialed === called`).
3. **Conserver `calling` comme `fromNumber`** (déjà correct — c'est le vrai appelant).
4. Idéalement, stocker AUSSI la patte de transfert dans les `properties` de l'event
   (ex `transfer_to_number`) pour ne pas perdre l'info de routage — utile au debug.

⚠️ **Impact dedup** : le `dedup_token` (`phone-call-event.ts:158`) et le `session_id`
dérivent peut-être de `toNumber`. Vérifier que changer `toNumber` ne casse PAS
l'idempotence des appels DÉJÀ ingérés (sinon double ingestion au prochain sync).
Si le token dépend de `externalId` (consumptionId) c'est safe — à confirmer.

## Problème 2 — Le sync avale TOUS les billing accounts du compte OVH (fuite cross-tenant)

### Symptôme

`fetchOvhCdr` (`ovh.ts:278` → `discoverAndFetch` ~`:291`) fait :
`GET /telephony` (TOUS les billingAccounts) → pour chacun `GET .../service`
(TOUTES les lignes) → pull tous les CDR.

Le compte OVH de Robert héberge **4 lignes, dont 3 sont des CLIENTS** :
- `0033482530429` → client **Tramtech**
- `0033972105485` → client **Sirpe**
- `0033482530745` → **Veridian** (le seul qui doit alimenter ce workspace)
- `0033482533156` → ligne non affectée

Résultat : les appels de **Tramtech et Sirpe** (clients de Robert) atterrissent dans
le workspace analytics **Veridian**. En multi-tenant réel (si Tramtech a un jour son
propre workspace), ce serait une **fuite de données entre clients** — inacceptable.

### Cause racine

Le connecteur découvre et pull tout le compte OVH au lieu de se limiter aux
**numéros déclarés du workspace** (`tenant_phone_numbers`).

### Fix attendu

Le pull OVH d'un workspace doit être **borné aux numéros mappés de CE workspace** :

1. Récupérer la liste des `e164` déclarés du workspace (`buildSourceLookup` les a déjà,
   `voip.service.ts:378`) AVANT le pull.
2. Dans `fetchOvhCdr` : soit
   - (a) **filtrer les lignes découvertes** pour ne garder que les `serviceName`
     dont le numéro ∈ numéros déclarés du workspace, soit
   - (b) **filtrer les CDR après normalisation** : ne garder que ceux dont
     `dialed` (numéro composé, post-fix Problème 1) ∈ numéros déclarés.
   → (a) est plus efficace (moins d'appels API OVH) mais exige de matcher
     `serviceName` (qui EST le numéro E.164 chez OVH, ex `0033482530745`) au mapping.
     (b) est plus robuste si un numéro est multi-ligne. **Recommandation : (a) en
     premier filtre + (b) en garde-fou final.**
3. Un workspace **sans aucun numéro mappé** ne doit RIEN pull (court-circuit early).
4. Si un même compte OVH sert plusieurs workspaces (cas Robert : Veridian + futurs
   Tramtech/Sirpe), chaque workspace ne doit voir QUE ses numéros. Le filtrage par
   numéro déclaré garantit l'isolation même avec creds OVH partagés.

## Problème 3 (sécurité) — Consumer key OVH scopé lecture seule téléphonie

### Contexte

Le branchement actuel réutilise le **consumer key OVH global** de Robert
(`OVH_CONSUMER_KEY` dans `~/credentials/.all-creds.env`), qui a un scope LARGE
(DNS, domaines, téléphonie, etc. — c'est la clé du skill `ovh-api`). Si cette clé
fuite depuis le container analytics-engine, elle donne accès à **tout le compte OVH**.

### Exigence

L'intégration VoIP OVH doit utiliser un **consumer key dédié, scopé en lecture
seule sur la téléphonie uniquement** :
```
GET  /telephony
GET  /telephony/*
GET  /me            (pour le testCredential)
```
Aucun droit POST/PUT/DELETE, aucun accès DNS/domaines/hébergement.

### Comment générer ce consumer key scopé (procédure OVH)

OVH permet de créer un consumer key avec des `accessRules` précises via
`POST /auth/credential` (endpoint non signé, retourne une `validationUrl` à valider
une fois par Robert dans le navigateur). Exemple de payload :
```json
{
  "accessRules": [
    { "method": "GET", "path": "/telephony" },
    { "method": "GET", "path": "/telephony/*" },
    { "method": "GET", "path": "/me" }
  ]
}
```
→ Robert valide l'URL retournée, le `consumerKey` devient actif, scopé lecture
téléphonie. Ce CK remplace `OVH_CONSUMER_KEY` dans le `creds` du workspace
(`applicationKey`/`applicationSecret` restent les mêmes — ils identifient l'app,
pas les droits).

> **Action côté agent analytics** : ce ticket NE demande PAS de générer le CK ici
> (c'est une action OVH côté Robert / agent veridian-site via skill `ovh-api`).
> Mais documenter dans la console / le skill `analytics-provision` que **le CK
> fourni doit être scopé `GET /telephony/*` lecture seule**, et idéalement ajouter
> un check dans `voip:cred-test` qui WARN si le CK a des droits trop larges
> (tester qu'un `POST` quelconque échoue en 403 = bonne hygiène). Optionnel mais
> recommandé.

## Comment contrôler / vérifier la feature avant de livrer

### 1. Tests unitaires (connecteur OVH)
- `normalizeOvhConsumption` : un CDR `wayType='transfer'` avec `dialed≠called` →
  `toNumber === dialed` (le numéro composé), `fromNumber === calling`.
- Un CDR sans renvoi (`dialed === called`) → comportement inchangé.
- Filtrage workspace : un compte OVH multi-lignes, workspace mappé sur 1 seul
  numéro → seuls les CDR de CE numéro sont retournés.
- Workspace sans numéro mappé → `[]` (zéro pull).

### 2. Test e2e vrai ClickHouse (modèle `api/test/*.e2e-spec.ts`)
- Provisionner un workspace de test, mapper 1 numéro, mocker la réponse OVH avec
  un CDR transfer + un CDR d'un AUTRE numéro (non mappé) → vérifier que SEUL le
  numéro mappé produit un event `phone_call`, avec `to_number` = numéro composé et
  `source_attributed='true'`.

### 3. Vérif manuelle en réel (workspace Veridian déjà branché)
Après déploiement du fix, re-sync et contrôler ClickHouse :
```bash
analytics voip:sync vrd_veridian_site_prod
ssh prod-pub "docker exec analytics-engine-prod-gkggyk-clickhouse-1 clickhouse-client --query \"
  SELECT goal_timestamp,
         properties['from_number'] AS appelant,
         properties['to_number']   AS numero_compose,
         properties['source']      AS source,
         properties['source_attributed'] AS attribue
  FROM staminads_ws_vrd_veridian_site_prod.goals FINAL
  WHERE goal_name='phone_call' ORDER BY goal_timestamp ASC FORMAT Pretty\""
```
**Attendu après fix** :
- `numero_compose` = `0033482530745` (le numéro Veridian) sur les appels Veridian
- `attribue` = `true`
- **Plus aucun** appel Tramtech (`0033482530429`) / Sirpe (`0033972105485`) dans ce
  workspace (filtrage cross-tenant OK).

### Référence — données réelles attendues (2 appels Veridian connus)
| date (Paris) | appelant (`calling`) | composé (`dialed`) | statut |
|---|---|---|---|
| 2026-06-15 12:06 | 0033629454311 (= mobile Robert, test) | 0033482530745 | answered 7s |
| 2026-06-24 16:37 | 0033626041350 (prospect réel) | 0033482530745 | missed 0s |

⚠️ Attention au TTL : la table `events` a un TTL 7j ; `goals`/`sessions` sont
durables. L'appel du 15 juin sort de la fenêtre de re-sync (`defaultLookbackDays=7`,
`voip-sync.service.ts:32`) — déjà ingéré, ne pas s'attendre à le re-pull.

## Fichiers concernés (repo analytics-engine)
- `api/src/voip/providers/ovh.ts` — type `OvhVoiceConsumption` (+`dialed`), `normalizeOvhConsumption` (mapping `toNumber`), `fetchOvhCdr`/`discoverAndFetch` (filtrage par numéro mappé)
- `api/src/voip/voip-sync.service.ts` — passage de la liste des numéros déclarés au pull, court-circuit si aucun numéro
- `api/src/voip/voip.service.ts:378` — `buildSourceLookup` (déjà la map e164→source, réutiliser pour le filtre)
- `api/src/voip/phone-call-event.ts` — vérifier que le `dedup_token`/`session_id` ne casse pas avec le nouveau `toNumber` ; ajouter `transfer_to_number` en properties (optionnel)
- `api/test/` — nouveau `voip-ovh-attribution.e2e-spec.ts`
- Doc : `~/.claude/skills/analytics-provision/SKILL.md` — noter l'exigence CK OVH scopé `GET /telephony/*` lecture seule

## Notes
- Branchement actuel laissé EN L'ÉTAT en prod (il fonctionne pour l'usage perso de
  Robert : il voit ses appels, source `direct` honnête). Le fix améliore
  l'attribution et bétonne l'isolation multi-tenant — pas un rollback.
- Pas d'OAuth OVH : signature à clés statiques (applicationKey/secret + consumerKey).
  Ne pas introduire de flow OAuth ici.
