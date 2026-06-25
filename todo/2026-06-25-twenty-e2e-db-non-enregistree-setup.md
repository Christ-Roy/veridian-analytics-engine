# Lot Twenty — e2e rouge : workspace DB `twenty_acq_stitch_ws` pas enregistrée dans setup.ts

> **Sévérité** : 🔴 P0 (staging rouge, bloque la promo prod)
> **Owner** : agent Lot Twenty (S6 connecteur)
> **Créé** : 2026-06-25
> **Déposé par** : agent Lot C (backfill/provenance/CLI)

## Contexte

Après mon push Lot C (fixes DI/mock + export FINAL), la suite **unit est verte
(87/87)** et **mes 3 e2e passent** (identity-backfill, user-id-export,
admin-platform). Le SEUL e2e rouge restant est le TIEN :

```
FAIL test/twenty-acquisition-stitch.e2e-spec.ts
  ● Twenty connector — stitched acquisition › signup of a stitched user →
    timeline AND Person field carry google_ads (read from REAL user_attribution)

  Database staminads_ws_twenty_acq_stitch_ws does not exist.
  Maybe you meant staminads_ws_identity_stitch_ws?.
```

(runs : Test & Coverage 28182901125 + Staging CI/CD 28182901057, étage 1.b.)

## Cause

`twenty-acquisition-stitch.e2e-spec.ts` utilise un workspace
`twenty_acq_stitch_ws` mais ce workspace DB n'est PAS enregistré dans
`api/test/setup.ts` → `ADDITIONAL_WORKSPACE_DATABASES`. Le globalSetup ne crée
donc jamais `staminads_ws_twenty_acq_stitch_ws`, et le test plante au 1er query.

(Piège connu — mémoire `feedback_agent_traps_2026-05-25` #2 / même piège que
j'ai géré pour MON workspace `staminads_ws_identity_backfill_ws`.)

## Fix (1 ligne, ton périmètre)

Dans `api/test/setup.ts`, ajouter à `ADDITIONAL_WORKSPACE_DATABASES` :

```ts
  // Twenty connector acquisition-stitch e2e (twenty-acquisition-stitch.e2e-spec.ts)
  'staminads_ws_twenty_acq_stitch_ws',
```

Je NE l'ai PAS fait moi-même : setup.ts est partagé et tu fais des reset --hard
fréquents (worktree partagé) — pour éviter une collision/perte, je te laisse
ajouter ta ligne (tu connais le nom exact du/des workspace(s) que ton spec
utilise — vérifie s'il y en a plusieurs : multi-tenant probe ?).

## Vérif attendue

`Staging CI/CD` + `Test & Coverage` verts (688/688 e2e). Mon Lot C est déjà vert
— ne touche pas à mes fichiers (identity-backfill*, user-provenance*,
export.service*, admin-platform.*).
