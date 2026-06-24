# Incohérences de contrat entre routes sœurs : shape `set*` + format e164

> **Sévérité** : 🟡 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Source** : audit comportemental M2M (probe-contracts)

Deux incohérences mineures mais réelles entre routes qui devraient être symétriques.

## 1. `crm.setMapping` renvoie un shape réduit vs les autres `set*`

Les 4 routes de customization write devraient renvoyer le même snapshot. Réel
(staging, 2026-06-24) :

```bash
# setBranding / setFeatures / setLayout → snapshot COMPLET :
... workspaces.setBranding {"workspace_id":"<ws>","branding":{"color":"#1a2b3c"}}
# → {"workspace_id","name","logo_url","branding","features","dashboard_layout","crm_mapping"}

# crm.setMapping → snapshot RÉDUIT :
... crm.setMapping {"workspace_id":"<ws>","crm_mapping":{"identity_resolver":"email","map_phone_calls":true}}
# → {"workspace_id","crm_mapping"}   ← seulement 2 champs
```

Un consommateur qui relit l'état après chaque `set*` (pour confirmer la persistance)
reçoit un objet différent de `crm.setMapping`. `getCustomization` reste la lecture
canonique (snapshot complet), mais l'asymétrie des réponses `set*` est un piège.

**Correctif** : faire renvoyer à `crm.setMapping` le même snapshot complet que ses
sœurs (réutiliser le retour de `getCustomization`), OU documenter explicitement que
les `set*` renvoient des shapes différents.

## 2. Format `e164` : deux contrats pour la même donnée

| Route | Validation e164 | Min | Max |
|---|---|---|---|
| `tenants.provision` → `PhoneNumberDto` | `@Length(8, 20)` | 8 | 20 |
| `voip.addPhoneNumber` → `VoipAddPhoneNumberDto` | `@MaxLength(32)` + `@IsNotEmpty` | 1 | 32 |

Le même numéro de téléphone est validé différemment selon qu'on le passe au
provisioning ou à l'ajout VoIP. `voip.addPhoneNumber` accepte un e164 de 1 à 7 chars
(rejeté par provision) et jusqu'à 32 (rejeté par provision à 20). Reproductions :

```bash
... voip.addPhoneNumber {"workspace_id":"<ws>","e164":"","source":"seo"}  # → 400 "e164 should not be empty"
# mais "e164":"+331" (4 chars) passerait sur addPhoneNumber et serait rejeté par provision
```

**Correctif** : aligner les deux DTO sur une borne unique (reco `@Length(8, 20)`
comme provision, l'E.164 réel fait 8-15 chiffres + `+`). Idéalement une seule
contrainte e164 partagée (validator commun) pour ne pas re-diverger.

## Impact consommateur

Faible. Pas de casse fonctionnelle, mais un même client peut avoir un numéro accepté
par une route et refusé par l'autre — incohérence visible si le Hub orchestre les deux.
