# conversions: le taux de conversion par app utilise le dénominateur du canal entier (taux faux)

> **Sévérité** : 🔴 P0 — données fausses montrées au client (taux de conversion gonflés/incomparables)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24

## Symptôme (reproductible)

```
$ analytics --env staging conversions vrd_veridian_site_staging --preset all_time
{
  "conversion_goals": ["signup", "app_started"],
  "rows": [
    { "channel_group": "", "app": "prospection",      "conversions": 12,  "sessions": 146, "conversion_rate": 8.22  },
    { "channel_group": "", "app": "(non renseigné)",  "conversions": 116, "sessions": 146, "conversion_rate": 79.45 },
    { "channel_group": "", "app": "notifuse",         "conversions": 2,   "sessions": 146, "conversion_rate": 1.37  }
  ]
}
```

Les **trois** lignes (apps différentes) partagent **le même `sessions: 146`** et le même `channel_group: ""`. Le dénominateur affiché est le total des sessions du canal, PAS les sessions du segment (channel × app). Résultat :

- Le `conversion_rate` de chaque app n'est pas un vrai taux : c'est `conversions_de_l_app / sessions_TOTALES_du_canal`. Numérateur et dénominateur ne couvrent pas le même périmètre.
- La somme des taux (8.22 + 79.45 + 1.37 = 89 %) n'a aucun sens et peut dépasser 100 % si plusieurs apps convertissent fort sur un même canal.
- Un client lisant « 79,45 % de conversion » sur l'app `(non renseigné)` est trompé : ce n'est pas 79 % des sessions de cette app qui ont converti.

## Cause

`api/src/analytics/analytics.service.ts` → `conversionsByChannel()` (~ lignes 593-642) :

- Le numérateur est groupé par **(channel_group, app)** :
  `SELECT channel_group, properties['app'] AS app, uniqExact(session_id) AS conversions FROM goals ... GROUP BY channel_group, app`
- Le dénominateur est groupé **uniquement par channel_group** :
  `SELECT channel_group, count() AS sessions FROM sessions FINAL ... GROUP BY channel_group`
- Au mapping (ligne ~633) : `const sessions = sessionsByChannel.get(r.channel_group) ?? 0;`
  → toutes les apps d'un même canal réutilisent le **même** dénominateur (sessions du canal entier).

Le numérateur a une granularité de plus (app) que le dénominateur. Division entre deux périmètres différents.

## Correctif (voie propre, pas de contournement)

Deux options, à trancher selon l'intention produit :

1. **Si le taux doit être par (canal × app)** : il faut un dénominateur par (canal × app). Mais une session n'a pas d'`app` (l'app vit sur le goal via `properties['app']`), donc « sessions de l'app X » n'est pas défini côté table `sessions`. → soit on retire la colonne `app` du regroupement (taux par canal seulement, agrégé sur toutes les apps), soit on définit explicitement le dénominateur = sessions du canal et on **renomme** le champ pour lever l'ambiguïté (`conversion_rate_vs_channel_sessions`) + on documente que c'est volontaire.

2. **Si le but est « combien de clients convertissent et sur quelle app »** (cf commentaire L557-561) : alors `conversion_rate` au sens « % de sessions converties » par app n'est pas calculable proprement (pas de sessions par app). Mieux vaut exposer `conversions` (compte brut) par (canal, app) SANS taux, et un `conversion_rate` agrégé séparé par canal uniquement.

Recommandation : option 2 — supprimer le `conversion_rate` au niveau (canal × app) tant qu'il n'a pas de dénominateur honnête, exposer le taux uniquement au niveau canal. Mettre à jour le DTO de réponse + les tests `analytics.service.spec.ts`.

## Impact

- Endpoint M2M `POST /api/admin/platform/analytics.conversionsByChannel` et l'équivalent user `POST /api/analytics.conversionsByChannel`.
- Tout widget console / rapport qui affiche ce taux par app montre des chiffres faux à un client.
- Bloquant pour la feature « conversions par canal » du scope commercial.
