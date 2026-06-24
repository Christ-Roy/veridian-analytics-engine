# `analytics.query` expose la requête SQL ClickHouse brute dans chaque réponse 200

> **Sévérité** : 🟡 P1 (fuite d'info interne)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Source** : audit comportemental M2M (probe-contracts)

## Symptôme reproductible

`POST /api/admin/platform/analytics.query` (et son équivalent workspace-scoped
`/api/analytics.query`) renvoie dans **chaque réponse nominale 200** un bloc
`meta.query.sql` contenant la **requête ClickHouse complète, brute** — noms de
tables internes (`sessions FINAL`), structure, noms de paramètres.

```bash
curl -sS -X POST -H "Authorization: Bearer $PLATKEY" -H 'Content-Type: application/json' \
  -d '{"workspace_id":"vrd_veridian_site_staging","metrics":["sessions"],"dateRange":{"preset":"previous_30_days"}}' \
  "$BASE/api/admin/platform/analytics.query"
```

Réponse (extrait réel) :
```json
{
  "data": [{"sessions":"146"}],
  "meta": {
    "metrics": ["sessions"], "dimensions": [], "total_rows": 1,
    "query": {
      "sql": "SELECT\n  count() as sessions\nFROM sessions FINAL\nWHERE created_at >= toDateTime64({date_start:String}, 3, 'UTC')\n  AND created_at <= toDateTime64({date_end:String}, 3, 'UTC')\n...ORDER BY sessions DESC\nLIMI..."
    }
  }
}
```

## Pourquoi c'est un problème

- **Surface d'attaque / divulgation** : exposer le SQL et le schéma interne
  (`sessions`, `events`, MV…) à tout détenteur d'une clé — y compris une clé
  workspace-scoped sur la route `/api/analytics.query` consommée par le
  front/clients — donne gratuitement la cartographie de la DB analytique. Standard
  OWASP : ne pas leaker la structure interne dans les réponses applicatives.
- **Contrat non documenté** : ni le SKILL.md ni le `AnalyticsQueryDto` n'annoncent
  ce champ `meta.query.sql`. C'est un champ « en plus » non documenté que des
  consommateurs pourraient se mettre à parser (couplage involontaire au SQL interne).

## Portée vérifiée (2026-06-24)

- **Route client-facing `/api/analytics.query` (clé workspace VIEWER, Bearer)** :
  testée → **200 SANS `meta.query.sql`**. La route client ne leake PAS le SQL. ✅
- **Route M2M `/api/admin/platform/analytics.query` (clé plateforme)** : leake le
  SQL. Détenteur = Hub uniquement → c'est pourquoi la sévérité reste 🟡 (et pas 🔴) :
  le SQL n'est exposé qu'au consommateur de confiance, pas aux clients.
- Reste à vérifier côté code : `meta.query.sql` est-il conditionné par un flag debug
  ou inconditionnel sur la branche M2M ? (le test montre qu'il est présent par défaut
  sur staging).

## Correctif proposé

Gater `meta.query.sql` derrière un flag debug **off par défaut en prod**, ou le
retirer purement de la réponse applicative (le garder en log serveur si utile au
debug). Documenter explicitement que la réponse ne contient PAS de SQL.

## Impact consommateur

Aucun consommateur légitime n'a besoin du SQL. Le retirer est non-breaking pour le
happy-path (data + meta agrégée restent). Bénéfice sécurité net.
