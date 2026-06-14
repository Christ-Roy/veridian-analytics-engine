# Brancher le connecteur Twenty sur le VRAI workspace commercial (pas REPLAY)

> **Sévérité** : 🟡 P1 — dernier maillon du tunnel pour usage réel
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-14
> **Demandeur** : Robert

## Contexte

Le connecteur Twenty natif est EN PROD et prouvé data-nickel (2026-06-14), MAIS
toute la preuve E2E a été faite contre le workspace de TEST **REPLAY**
(veridian-3wm3l1xq), pas contre le vrai workspace commercial Twenty de Robert.

La mécanique est garantie (22 tests prod verts : auth, idempotence, isolation,
data complète, redaction). Il reste l'**activation réelle** : créer le webhook
qui pointe le VRAI workspace commercial.

## À faire

1. Identifier le vrai workspace Twenty commercial (celui avec les vrais prospects
   + fields tunnel score/auditSlug). ⚠️ NE PAS confondre avec le workspace de
   prospection réelle accessible via le MCP (cf reference_mcp_twenty_points_to_prod).
2. Provisionner une clé workspace `vrd_veridian_site_prod` (endpoint M2M
   `POST /api/admin/platform/workspaces.provisionApiKey`, déjà en prod).
3. Créer le webhook `transform.type=twenty`, `dry_run:false`, url+bearer du vrai
   workspace commercial.
4. Faire un parcours de contrôle sur UN prospect test réel (ou un vrai en se
   coordonnant avec Robert) → vérifier que score+timeline arrivent sur sa vraie
   fiche, sans polluer les autres.
5. Décision Robert avant d'activer en grand (écriture sur de vraies fiches client).

## Note

Le push idempotent + dédup garantit qu'un re-run ne crée pas de doublon, donc
l'activation est réversible/sûre. Workspace REPLAY reste la cible de test/CI.
