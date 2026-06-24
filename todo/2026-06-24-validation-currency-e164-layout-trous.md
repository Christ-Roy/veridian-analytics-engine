# Trous de validation M2M : currency libre, e164 indicatif fantôme, widgets layout

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-analytics-engine
> **Créé** : 2026-06-24
> **Trouvé par** : probe-lifecycle (audit cycle de vie M2M, staging)

Audit du cycle de vie complet d'un workspace via le CLI `analytics` (staging,
workspace `probe_lifecycle_test`). La plupart des validations sont **bonnes** (voir
récap en bas). Trois champs acceptent des valeurs invalides à tort — write 200,
valeur persistée, pas d'erreur. Aucun n'est critique seul, mais ce sont des données
sales qui casseront en aval (formatage, sync).

## 1. `currency` : AUCUNE validation (le plus net)

`settings --currency` accepte n'importe quelle chaîne et la persiste :

```
$ analytics --env staging settings probe_lifecycle_test --currency BANANABUCKS
  → currency: BANANABUCKS          # accepté + persisté
$ analytics --env staging settings probe_lifecycle_test --currency X
  → X                              # 1 char accepté
$ analytics --env staging settings probe_lifecycle_test --currency AAAAAAAAAAAAAAAAAAAA
  → AAAAAAAAAAAAAAAAAAAA           # 20 chars accepté
```

Contraste flagrant avec `timezone` dans la MÊME commande, qui est strictement
validée :

```
$ analytics --env staging settings probe_lifecycle_test --timezone Mars/Olympus_Mons
  → ['timezone must be a valid IANA timezone identifier']   # rejet propre ✓
```

**Impact** : une devise non-ISO-4217 dans le workspace fera planter / mal afficher
le formatage monétaire de la console (`Intl.NumberFormat(locale, {style:'currency',
currency})` lève `RangeError` sur un code invalide). La console française attend
EUR/GBP/USD… ; rien ne garantit ça côté M2M.

**Fix** : valider `currency` contre ISO 4217 (liste fermée, ou regex `^[A-Z]{3}$` a
minima) dans le DTO `settings`, comme c'est déjà fait pour `timezone`.

## 2. `voip:add` : e164 au format OK mais indicatif pays fantôme accepté

La validation e164 vérifie la forme (`+` + chiffres, longueur min) mais pas que
l'indicatif/numéro existe :

```
$ analytics --env staging voip:add probe_lifecycle_test --e164 +99999999999999 --source direct
  → {'e164': '+99999999999999', ...}   # ACCEPTÉ (indicatif +999 inexistant)

# corrects rejets par ailleurs :
$ ... --e164 +331            → {'code':'invalid_e164'}   # trop court ✓
$ ... --e164 +33ABC123456    → {'code':'invalid_e164'}   # lettres ✓
$ ... --e164 pas-un-numero   → {'code':'invalid_e164'}   ✓
```

Bonus utile à connaître (PAS un bug) : un numéro FR sans indicatif est auto-normalisé
→ `0612345678` devient `+33612345678`. Comportement intelligent à documenter.

**Impact** : faible. Un numéro à indicatif fantôme ne matchera jamais un vrai call
log → sync VoIP silencieusement vide sur ce numéro. Pollue les données, pas de crash.

**Fix** : passer la validation e164 par une vraie lib (libphonenumber / `parsePhoneNumber`)
qui valide l'indicatif pays, plutôt qu'un regex de forme. Optionnel vu la sévérité.

## 3. `ui:layout` : noms de widgets non validés

`--order` et `--hide` acceptent des widgets inexistants :

```
$ analytics --env staging ui:layout probe_lifecycle_test --order this_widget_does_not_exist,banana
  → {'order': ['this_widget_does_not_exist', 'banana']}    # accepté
$ analytics --env staging ui:layout probe_lifecycle_test --hide nonexistent_widget
  → {'hidden_widgets': ['nonexistent_widget']}             # accepté
```

**Impact** : très faible — le front ignore un widget inconnu. Mais un `--order`
incomplet ou avec des typos donne un layout silencieusement bancal côté console.

**Fix** : valider contre la liste fermée des widgets connus (enum), ou au moins
documenter la liste valide dans le SKILL/CLI help. Sévérité P3 réelle.

## Note adjacente — comportement layout (PAS un bug, à documenter)

`ui:layout` est **full-replace** (assumé dans le code : `/** ... Full replace. */`).
Un `--order` seul efface le `hidden_widgets` précédent et vice-versa. Contrairement
à `ui:features` qui PRÉTEND deep-merger (et le fait mal, cf ticket
`2026-06-24-setfeatures-replace-au-lieu-de-deep-merge.md`), le layout n'a jamais
promis de merger — mais le CLI ne prévient pas l'admin qu'il écrase. À documenter
dans le help (« remplace l'intégralité du layout »).

## Ce qui MARCHE bien (validé pendant l'audit, pour contexte)

- branding `--color` : strict `#rrggbb`, refuse 3-digit / sans-`#` / mots, garde
  l'ancienne valeur sur rejet ✓
- timezone : IANA strict ✓
- crm:map : enum `identity_resolver` (auto/email/field) validé, garde l'ancien
  mapping valide sur rejet d'un malformé ✓
- voip source : enum côté CLI (argparse) ✓
- voip creds OVH : valide les noms de champs requis, message FR clair, masquage
  `••••XXXX` correct ✓
- webhooks url : http(s) strict, ftp/url-bidon rejetés ✓
- webhooks transform/auth : enums ✓
