# channel_group / channel vides sur la quasi-totalité des sessions (backfill attribution jamais exécuté)

> **Sévérité** : 🟡 P1 — incohérence interne visible au client (dashboard acquisition quasi vide), mais cause = dette de données, pas bug du code vivant
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24

## Symptôme (reproductible)

Sur `vrd_veridian_site_staging` (147 sessions all_time), la dimension `channel_group` est vide pour 146 sessions sur 147 :

```
$ analytics --env staging query vrd_veridian_site_staging --metrics sessions --dimensions channel_group --preset all_time
[ {"channel_group":"","sessions":"146"}, {"channel_group":"direct","sessions":"1"} ]
```

Et surtout, **incohérence interne prouvée par croisement** — une session a un `utm_medium` renseigné mais un `channel_group` vide :

```
$ analytics --env staging query vrd_veridian_site_staging --metrics sessions --dimensions channel_group,utm_medium --preset all_time
[
  {"channel_group":"",       "utm_medium":"",      "sessions":"145"},
  {"channel_group":"direct", "utm_medium":"",      "sessions":"1"},
  {"channel_group":"",       "utm_medium":"email", "sessions":"1"}   ← INCOHÉRENT
]
```

D'après `api/src/events/derive-channel.ts`, `EMAIL_MEDIUMS` contient `email`, donc une session `utm_medium=email` DOIT être classée `channel=email` / `channel_group=email`. Or elle est vide. Idem `country` (147/147 vides), `device` (142/147 vides) — mais channel est le plus grave car c'est une feature commerciale (conversions/funnel par canal, comparaison web↔appel téléphonique).

## Cause

- Le canal est **figé à l'ingestion** par `deriveChannel()` (cf `derive-channel.ts` docstring : « Le canal est figé à l'ingestion … `sessions_mv` propage `any(e.channel)` »). C'est un bon design (immuabilité de l'attribution d'acquisition).
- MAIS la dérivation a été livrée par le chantier S1 (`todo/done/2026-06-23-CHANTIER-attribution-bout-en-bout.md`), qui notait explicitement (L64) : *« Migration de backfill optionnelle pour l'historique »* — et ce backfill **n'a jamais été exécuté**.
- Conséquence : toutes les sessions ingérées AVANT le déploiement de S1 ont `channel`/`channel_group` vides en base, de façon permanente (figées). Le croisement `utm_medium=email` + `channel_group=""` le prouve : ce n'est pas que la donnée source manque, c'est que la dérivation n'a pas tourné sur ces lignes.

## Correctif (voie propre)

Exécuter le **backfill d'attribution** sur les sessions/goals historiques :

1. Recalculer `channel`/`channel_group` à partir des signaux déjà stockés (`utm_*`, `referrer`, `referrer_domain`, `is_direct`, `utm_id_from`) via la même fonction pure `deriveChannel()` — surtout PAS une logique SQL parallèle qui divergerait de la dérivation d'ingestion.
2. S'appuyer sur le mécanisme de backfill existant (`api/src/filters/backfill/`) qui sait déjà ré-écrire des colonnes dérivées et émet `backfill.completed` (le service analytics invalide alors son cache, cf `handleBackfillCompleted`).
3. Tester d'abord sur staging (workspace `vrd_veridian_site_staging`), vérifier que la session `utm_medium=email` passe à `channel_group=email`, que les totaux restent conservés (somme par canal == total sessions), puis promo prod.

Note : sur staging la plupart des sessions vides sont des fixtures E2E sans UA/géo (channel `direct`/`other` attendu après backfill, pas `email`) — c'est normal. Le but du backfill est qu'AUCUNE session avec un signal exploitable ne reste à `channel_group=""`.

## Impact

- Endpoints : toute `query`/`conversions`/`funnel` filtrée ou groupée par `channel_group` → résultats vides/faux pour l'historique.
- Feature commerciale « conversions par canal » et comparaison web↔appel (`phone_source` ↔ `channel_group`) inexploitable tant que l'historique n'est pas backfillé.
- Pas de risque de régression : la dérivation d'ingestion (nouvelles sessions) fonctionne déjà ; c'est uniquement le rattrapage de l'historique.
