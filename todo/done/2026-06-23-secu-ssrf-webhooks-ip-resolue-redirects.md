# SSRF webhooks : validation sur le hostname littéral, pas l'IP résolue (+ redirects suivis)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-23

## Contexte / Symptôme

Le guard SSRF du module webhooks ne valide que le **littéral hostname** au moment
de la création/update du webhook ; il ne résout JAMAIS le DNS. Le commentaire
(`ssrf-guard.ts:18-22`) le reconnaît comme limitation V1 ("Phase 2 will add DNS
resolution + force-IP"). C'est donc une dette connue, mais c'est un **vrai trou
SSRF exploitable** :

1. **DNS post-validation** : `https://evil.com/hook` passe le check ; l'attaquant
   fait ensuite pointer `evil.com` sur `127.0.0.1` ou `169.254.169.254`
   (métadonnées cloud OVH/GCP).
2. **DNS rebinding** : TTL court, première résolution publique pour passer le
   check, seconde résolution privée au moment du `fetch` du worker (~10s plus tard).
3. **Redirects suivis** : le `fetch` natif suit les 3xx par défaut sans
   re-valider la cible — un endpoint public peut renvoyer `302 → http://169.254.169.254/...`.

Accès requis : rôle `webhook.write` (owner/admin du workspace), donc un tenant
malveillant sur son propre workspace. Surface réduite mais réelle, avec impact
exfiltration de credentials cloud via metadata endpoint + scan de services
internes.

## Localisation (fichiers + lignes)

- `api/src/common/ssrf-guard.ts:18-22, 26-54, 107` — validation sur littéral, pas IP résolue
- Worker : `api/src/webhooks/webhook-delivery-worker.service.ts` — `fetch` sans `redirect: 'manual'`

## Correctif proposé

1. Résoudre le hostname (`dns.lookup`, toutes adresses) et rejeter si une IP est
   privée / loopback / link-local / metadata.
2. Pinner l'IP validée via un `http.Agent` custom (`lookup` forcé) au moment du
   `fetch`, pour fermer le TOCTOU / rebinding.
3. Passer `redirect: 'manual'` sur les `fetch` sortants du worker et rejeter les
   3xx (ou re-valider la `Location` contre le guard).

NB : un ticket "Phase 2" est mentionné en commentaire ; ce ticket le formalise et
le priorise (P1, pas "plus tard").

## Impact si non corrigé

SSRF vers les métadonnées cloud (exfiltration de credentials d'instance) et scan
réseau interne, déclenchable par tout owner de workspace. À traiter avec le ticket
`2026-06-23-secu-webhooks-test-sans-garde-ssrf.md` (même périmètre).

## ✅ Résolu — 2026-06-23 (agent veridian-analytics-engine)

- `common/ssrf-guard.ts` : ajout méthode async `assertSafeUrlResolved()` qui
  fait le check littéral SYNC puis **résout le hostname** (`dns.lookup`, all
  addresses, resolver injectable pour les tests) et **rejette si UNE IP résolue
  est privée/loopback/link-local/metadata** (`isPrivateIp` partagé v4+v6, +
  CGNAT 100.64/10, + IPv4-mapped ::ffff:). Ferme le trou "evil.com passe le
  check littéral puis pointe sur 127.0.0.1 / 169.254.x" et le DNS-rebinding où
  le record privé est publié après création.
- `webhook-delivery-worker.service.ts` : `sendOne()` appelle
  `assertSafeUrlResolved()` AVANT tout fetch + `fetch(..., { redirect: 'manual' })`
  qui rejette tout 3xx (`redirect_blocked:`) au lieu de suivre une `Location`
  non re-validée. Le chemin Twenty (`flushTwentyGroup`) passe au guard résolu
  aussi. Rejets SSRF/redirect classés **terminaux** (pas de retry) dans
  `recordOutcome`.
- Tests : `ssrf-guard.spec.ts` (isPrivateIp v4/v6/mapped/CGNAT +
  assertSafeUrlResolved : loopback/metadata/mixte/DNS_RESOLUTION_FAILED/
  short-circuit IP littérale/escape allowPrivate) ;
  `webhook-delivery-worker.service.spec.ts` (loopback/metadata/privé littéral +
  hostname qui RÉSOUT vers privé + 3xx non suivi).
- Résiduel documenté : TOCTOU rebinding sub-seconde non pinné (Node `fetch`
  global n'accepte pas de `lookup` custom sans dispatcher undici externe — refus
  d'ajouter une dep). Combiné au `redirect: 'manual'` + check toutes-IP, les
  chemins d'exploit pratiques sont fermés.
