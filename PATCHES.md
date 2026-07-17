# Patches Veridian sur fork staminads

> Ce fork de [staminads](https://github.com/staminads/staminads) (AGPL-3.0) contient
> des patches Veridian-spécifiques qui ne seront pas remontés upstream.
>
> Base : staminads v6.1.0 (commit `8039580e3ee2006f0c9fffd9c3aca64b31405425`).
> Date du fork : 2026-05-18.

## Stratégie de maintenance

- Branche `upstream/master` : suit le repo staminads upstream pour cherry-pick les bugfixes
- Branche `veridian/main` : notre version mainline avec tous les patches Veridian
- Branche `staging` : auto-deploy sur dev-pub (`analytics-engine.staging.veridian.site`)
- Branche `main` (prod) : auto-deploy prod via job Nomad `analytics-engine` (`analytics-engine.app.veridian.site` ; ex-Dokploy, décommissionné 2026-07-10 — cf `deploy/README.md`)

## Patches actifs

| ID | Description | Statut | Branche |
|---|---|---|---|
| 0001 | Visitor ID persistant (cookie 365j) | À implémenter Phase 2 | `feat/0001-visitor-id` |
| 0002 | Rebranding console (logo + couleurs Veridian) | À implémenter Phase 5 | — |
| 0003 | CGU + banner cookies dans le snippet d'install | À implémenter Phase 2 | — |

## Conformité AGPL

- Le fork reste sous AGPL-3.0
- Aucune redistribution publique
- Si un client en demande la source, on lui donne (la licence l'oblige si on lui sert
  le SaaS via réseau)
- Ne PAS supprimer le fichier `LICENSE` ni les copyrights staminads existants

## Synchronisation upstream

```bash
# Récupérer les derniers commits upstream
git fetch upstream

# Cherry-pick un bugfix ciblé
git cherry-pick <sha-upstream>

# OU rebase complet (à éviter — préférer cherry-pick pour garder le contrôle)
git rebase upstream/master
```
