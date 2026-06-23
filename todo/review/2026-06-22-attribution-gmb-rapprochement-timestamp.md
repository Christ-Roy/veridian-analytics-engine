# 🔵 [REVIEW] Attribution GMB par rapprochement de timestamps

> **Sévérité** : 🔵 à cadrer · **Owner** : Robert + agent engine · **Créé** : 2026-06-22
> **Statut** : FLOU — à reviewer ensemble AVANT tout code

## Idée (Robert 2026-06-22)
À terme, quand l'analytics est branché avec **GMB (Google My Business)**, faire de
l'**attribution via Veridian Analytics** par **rapprochement de timestamps** :
relier un appel/lead venu de GMB à une visite web (ou inversement) en matchant les
horodatages, pour attribuer la conversion à la bonne source.

## Questions ouvertes à trancher (Robert)
1. **Source des données GMB** : API Google Business Profile ? export manuel ? Quels
   events GMB exploitables (appels depuis la fiche, clics itinéraire, clics site) ?
2. **Mécanique de matching** : fenêtre temporelle (±N minutes ?) entre un event GMB
   et une visite web/appel VoIP. Comment gérer les **faux positifs** (2 visiteurs
   au même moment) ? Probabiliste ou déterministe ?
3. **Clé de jointure** : timestamp seul, ou timestamp + numéro de tél + géo ?
4. **Source de vérité** : l'attribution vit côté engine (nouvelle table) ou côté
   bridge/CRM ? Comment l'exposer (un champ source « gmb » dans le CRM) ?
5. **Volume / fiabilité** : à quel point on assume l'imprécision ? Afficher un
   « score de confiance » d'attribution ?

## Pourquoi en review
Sujet R&D avec vrai risque de faux positifs et de complexité. Pas de code tant que
la mécanique (fenêtre, faux positifs, source GMB) n'est pas tranchée avec Robert.

## MAJ 2026-06-23 — reste en review, prérequis = le channel
Ce ticket attend le socle d'attribution : impossible d'attribuer "gmb" tant que le `channel`/
`channel_group` n'est pas dérivé à l'ingestion (cf `2026-06-23-CHANTIER-attribution-bout-en-bout.md`
S1 — aujourd'hui `channel_group` est 100% vide en prod, vérifié). Une fois S1 fait, GMB pourrait
devenir une valeur de `channel` (referrer google maps / business.google) AVANT de se lancer dans
le rapprochement de timestamps probabiliste. Reste R&D à cadrer avec Robert (faux positifs).
