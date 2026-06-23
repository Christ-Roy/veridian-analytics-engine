# 📚 CHANTIER — Remettre la doc en parité avec le code réel (3 chantiers doc fusionnés)

> **Sévérité** : 🟡 P1 (doc qui ment > doc absente : induit chaque nouvel agent en erreur + risque AGPL)
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23 (fusion de doc-analytics-reference + doc-cartographie-modules + doc-perimee-readme-patches)
> **Vérifié contre** : `origin/staging` (= prod v10.0.0), 2026-06-23

## Pourquoi la fusion

Trois tickets doc séparés (`doc-analytics-reference-incomplete-perimee`,
`doc-cartographie-modules-backend`, `doc-perimee-readme-patches`) = un seul chantier :
**aligner la doc sur le code réel**. Un agent unique fait la passe en une fois.

## D1 — `docs/ANALYTICS_REFERENCE.md` : 2 écarts doc↔code

1. **`phone_call` (event différenciateur n°1) absent de toute la doc de référence.**
   `grep -i 'phone_call|téléphon|voip'` dans ANALYTICS_REFERENCE.md = 0. C'est l'event
   qui justifie la vente (appel tracké par source). Ajouter une section : nom de l'event,
   dimensions `phone_source` (enum seo/ads/direct/…) + `phone_number_e164`, comment le
   requêter dans Explore/Goals. Idem ériger en exemple-phare dans `docs/EVENTS-CUSTOM.md`.
2. **Métrique `pageviews` documentée comme fonctionnelle alors qu'elle THROW.**
   `ANALYTICS_REFERENCE.md:26` présente `pageviews = countIf(name='screen_view')` avec
   exemple `3,456`. VÉRIFIÉ PROD 2026-06-23 : `query pageviews` → **HTTP 500** (colonne
   `name` inexistante sur table `sessions`). `PLATFORM-ADMIN-API.md:135` dit l'inverse
   ("ne pas utiliser pageviews"). Deux docs se contredisent. → Corriger/retirer la ligne.
   ⚠️ **Coordonner avec le ticket `fix-metric-pageviews-native-cassee`** : si la métrique
   est retirée/aliasée côté code, mettre la doc en cohérence dans la même passe.

## D2 — Cartographie des modules backend (parité doc↔code)
`api/src/app.module.ts` câble ~26 modules. Le `CLAUDE.md` repo ne décrit l'engine que
comme un bloc générique. Aucun agent ne sait sans lire le code ce qui est actif / dormant /
hors-scope → re-développement ou sur-investissement récurrent (plusieurs tickets de l'audit
2026-06-17 découlaient de cette absence). Ajouter dans `CLAUDE.md` (annexe) un tableau :
rôle 1 ligne + statut (actif Veridian / actif staminads conservé / dormant / hors-scope) +
surface (UI / API-only / cron / cross-app). Points saillants à acter dans le tableau :
- `assistant` = **dormant** (clé Anthropic jamais câblée — arbitrage Robert 2026-06-18 :
  laisser tel quel, cap "IA-first = tout pilotable par API").
- `webhooks` = actif backend, **0 UI**, API-only/cross-app assumé (porte le connecteur Twenty).
- `audit` = alimenté, **0 UI** (cf ticket `journal-audit-sans-surface-ui` pour décider de l'UI).
- `subscriptions` = gardé mais à gater (cf ticket `subscriptions-cron-non-gate`).
- `tools` = SSRF déjà durci (vague 2026-06-23). `export`/`tunnel` = M2M cross-app by design.

## D3 — Docs racine périmées (README + PATCHES, dont conformité AGPL)
1. **`VERIDIAN-README.md` "Architecture two-tier" FAUSSE** : prétend que le métier (auth/GSC)
   vit dans un repo Next.js `veridian-analytics` séparé. FAUX : le bridge est DANS ce repo
   (`veridian-bridge/`), le legacy Next.js est **condamné**, et tout le métier (GSC, VoIP,
   provisioning M2M) est **porté nativement** dans l'engine. Réécrire pour refléter
   bridge+engine dans ce repo (aligner sur `CLAUDE.md` two-tier).
2. **`PATCHES.md` (doc AGPL légale) ment** : liste 0001 visitor_id / 0002 rebranding comme
   "à implémenter" alors qu'ils sont LIVRÉS (visitor_id = base du tunnel + vague B2B 2026-06-23 ;
   rebranding = console FR refondue). Passer en "Livré" (avec SHA/PR), re-statuer 0003 CGU/cookies
   après vérif code, et **ajouter les patches Veridian réels livrés depuis** (port natif GSC,
   port natif VoIP, admin-platform M2M, connecteur Twenty natif) — c'est ce que la licence AGPL
   impose de fournir à un client qui réclame la source. Un `PATCHES.md` mensonger = risque conformité.

## Tickets absorbés (supprimés)
`2026-06-17-doc-analytics-reference-incomplete-perimee.md`,
`2026-06-17-doc-cartographie-modules-backend.md`,
`2026-06-17-doc-perimee-readme-patches.md`.
