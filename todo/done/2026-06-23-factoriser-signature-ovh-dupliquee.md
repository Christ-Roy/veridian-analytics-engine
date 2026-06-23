# Factoriser la signature HMAC OVH dupliquée (2 chemins vivants)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme
L'algo de signature HMAC d'authentification OVH est copié-collé à l'identique
dans DEUX endroits, tous deux vivants :
- `api/src/voip/voip.providers.ts:200-219` (test de connexion VoIP)
- `api/src/voip/providers/ovh.ts:67-85` (`signOvhRequest`, sync des call logs)

## Impact si non corrigé
Si OVH change son schéma de signature, on patchera un seul des deux chemins →
symptôme silencieux côté client : "le test de connexion passe mais les appels
ne remontent pas" (ou l'inverse). Dette qui mord, pas cosmétique.

## Correctif proposé
Extraire une seule fonction `signOvhRequest()` (garder celle de
`providers/ovh.ts`, la plus complète) et la consommer depuis `voip.providers.ts`.
Supprimer la copie. Vérifier que le test de connexion ET la sync passent toujours
(test ciblé `npx jest` sur le voip).
