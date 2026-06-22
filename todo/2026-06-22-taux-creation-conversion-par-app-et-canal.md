# 🟡 Taux de création / conversion par app, segmenté par canal

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine (+ coordination Hub)
> **Créé** : 2026-06-22
> **Dépend de** : `2026-06-22-channel-jamais-calcule-attribution-borgne.md`

## Demande (Robert 2026-06-22)

Qu'Analytics nous dise, **pour les apps**, le **taux de création** (de comptes /
tenants) et le funnel de vente, **en sachant d'où ils viennent** (ads / seo /
autres canaux). Donc : combien de visiteurs → combien de créations de compte, par
app et par canal.

## Constat (audit 2026-06-22) — ce qui existe

- Les goals **`signup`** et **`app_started`** sont déjà trackés et portent
  **`properties.app`** (quelle app), exploités par le tunnel-aggregator
  (`api/src/tunnel/tunnel-aggregator.ts:30-31,139`). Donc l'engine SAIT déjà
  reconnaître une création de compte par app SI l'app pousse l'event.
- Le channel d'acquisition (ads/seo/…) = ticket prérequis (channel calculé).

## Périmètre — qui fait quoi (à cadrer)

⚠️ « Taux de création de compte par app » est **cross-app** : la vérité du
provisioning (combien de comptes créés sur Hub/Prospection/Notifuse) vit au **Hub**
(orchestrateur). L'engine peut le MESURER côté funnel web (visiteur → signup) SI :
1. Chaque app (ou le Hub) pousse un goal `signup`/`app_started` avec
   `properties.app` ET l'identité, vers l'analytics du site d'acquisition.
2. Le channel du visiteur est calculé (prérequis).

→ **Deux volets** :
- **Volet ENGINE (ce ticket)** : exposer un endpoint/vue « conversions par app ×
  canal » : pour une plage de dates, nombre de `signup`/`app_started` groupés par
  `properties.app` × `channel`, + taux vs sessions (taux de conversion visite→compte
  par canal). Réutilise la dimension channel + le funnel.
- **Volet HUB (ticket à déposer côté Hub)** : confirmer que le Hub/les apps poussent
  bien le goal `signup` avec `app` + l'attribution (channel/utm) au bon workspace
  analytics. Sans ce push, l'engine ne voit pas les créations. → ticket Hub à créer
  une fois le besoin validé (NE PAS coder côté Hub depuis ici, scope strict).

## Demande précise (volet engine)

1. Endpoint analytics « conversions par app » : group by `properties['app']` ×
   `channel`/`channel_group`, métrique = count de goals signup/app_started + taux
   vs sessions du même canal. Workspace-scoped + équivalent M2M admin.
2. Vue UI : un breakdown / mini-funnel « création de compte par app, filtrable par
   canal » (natif staminads, pas de page custom).

## Questions à clarifier avec Robert (peut basculer en review)
- « Les apps » = les apps SaaS Veridian (Hub/Prospection/…) OU les sites clients
  qu'on track ? (change la source des events signup).
- L'attribution se fait sur le **site vitrine** (où le visiteur arrive via ads/seo)
  puis le signup se fait sur le Hub → il faut propager le channel du vitrine au
  signup Hub (= chaîne d'attribution cross-domain, recoupe le tunnel cold↔web).
- → Si le cross-domain vitrine→Hub est flou, **basculer ce ticket en review**.

## Lien
Roadmap : `2026-06-22-ROADMAP-skill-analytics-et-integrations-surmesure.md`.
Recoupe le tunnel cold↔web ([[project_tunnel_connecteur_twenty_natif_design_b]]).
