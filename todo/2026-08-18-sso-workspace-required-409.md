# [ENGINE] SSO : émettre un 409 `workspace_required` au lieu de deviner le workspace

> **Sévérité** : 🟡 P2 — pas de faille, mais un jeton peut atterrir sur le
> mauvais espace client quand l'utilisateur en a plusieurs.
> **Créé** : 2026-08-18, en marge de la mission d'hygiène
> **Fichier** : `api/src/sso/sso.service.ts`, méthode privée `resolveWorkspace`
> **Contrat de référence** : `veridian-hub/todo/2026-07-28-autologin-analytics-contrat-et-etat-reel.md` §3.3bis

---

## Le comportement actuel

Quand le Hub n'envoie pas de `workspace_id` — ce qui est **le cas nominal
aujourd'hui**, son client `lib/auth/bounce-apps.ts` ne l'envoie jamais —
l'engine retombe sur le premier workspace du user, trié par `workspace_id` :

```sql
SELECT workspace_id FROM workspace_memberships FINAL
WHERE user_id = {userId:String}
ORDER BY workspace_id
LIMIT 1
```

Pour un client mono-workspace, c'est juste. Pour un client qui en a deux,
**c'est un tirage au sort déguisé en ordre alphabétique** : il clique
« Ouvrir Analytics » dans le Hub et atterrit sur un espace au hasard, sans
que rien ne signale l'ambiguïté.

Ce n'est pas une faille de cloisonnement — le jeton reste scopé à un
workspace dont l'utilisateur EST membre, ce point est vérifié et couvert par
un test. C'est un problème d'exactitude, pas de sécurité.

## Ce que le contrat prévoit

§3.3bis, et le raisonnement y est bon : **aucun jeton non scopé n'est jamais
émis**. Si l'engine ne peut pas déterminer la cible, il refuse et rend la
main au Hub, qui a une UI pour poser la question.

```
409 { "error": "workspace_required",
      "workspaces": [ { "id": "...", "name": "..." } ] }
```

Le Hub rappelle alors en nommant le workspace : un seul → immédiat, plusieurs
→ choix utilisateur. La complexité du multi-workspace remonte là où il y a un
écran pour la résoudre.

## Travail à faire

### Côté engine

1. `resolveWorkspace` : quand `workspaceId` est absent, lister **tous** les
   workspaces du user (avec leur `name`, pas seulement l'id — la requête
   actuelle ne récupère que `workspace_id`, il faut joindre la table des
   workspaces).
2. 0 workspace → `400 user_not_in_app` (déjà le cas, ne pas changer).
3. Exactement 1 → l'utiliser directement. Renvoyer un 409 ici serait un
   aller-retour gratuit pour l'écrasante majorité des clients.
4. 2 ou plus → `409 { error: 'workspace_required', workspaces: [...] }`.
5. Tests : le cas 1 workspace (pas de 409), le cas 2 workspaces (409 + la
   liste complète et nommée), et le cas `workspaceId` fourni non membre qui
   doit rester un `403 workspace_mismatch`.

### Côté Hub — indispensable, sinon la situation empire

⚠️ **Ne pas livrer l'engine seul.** Le client Hub actuel ne connaît pas le
409 : il tomberait dans son `if (!response.ok)` final et lèverait
`BounceError('unreachable')`. Un client multi-workspace passerait donc d'un
« mauvais espace » à un « app injoignable ». C'est une régression.

Il faut, dans le même mouvement : gérer le 409 dans `issueMagicLinkForApp`,
et un écran de choix côté Hub.

## Dépendance à traiter d'abord

Ce ticket n'a de sens qu'**après** l'alignement de la route. Aujourd'hui le
Hub appelle `POST /api/sso/issue-magic-link` alors que l'engine expose
`POST /api/sso.issueToken` : le flux ne fonctionne pas du tout, donc le choix
du workspace ne se pose même pas encore.

---

## Annexe — autre référence morte constatée

`veridian-platform/CLAUDE.md`, cité **trois fois** comme source de vérité par
le `CLAUDE.md` de ce dépôt, **n'existe pas** :

```
CLAUDE.md:180  cf §"Pricing & trial cross-app" racine `veridian-platform/CLAUDE.md`
CLAUDE.md:304  Cf doc cross-repo `~/Bureau/veridian-platform/CLAUDE.md` §"🔥 Règle d'or …"
CLAUDE.md:340  … racine `veridian-platform/CLAUDE.md`
```

```bash
$ ls ~/Bureau/veridian-platform/CLAUDE.md
No such file or directory
```

Même famille que les autres trouvailles du 2026-08-18 : ça ne casse rien, ça
oriente vers un document absent. Un agent qui cherche la règle d'or du
trunk-based ou la doctrine pricing ne la trouvera pas — et risque de la
réinventer. À traiter séparément : soit le document est à écrire, soit les
renvois pointent au mauvais endroit. Non traité ici, simplement consigné.
