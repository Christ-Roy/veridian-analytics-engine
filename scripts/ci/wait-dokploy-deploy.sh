#!/usr/bin/env bash
# wait-dokploy-deploy.sh — juge la réussite d'un déploiement prod Dokploy.
#
# Exécuté SUR le VPS prod (via ssh), lit DOKPLOY_API_KEY dans ~/credentials.
# Usage : COMPOSE_ID=<id> bash wait-dokploy-deploy.sh   (ou $1)
# Émet sur stdout le verdict final : DONE | FAILED   (+ progression sur stderr).
#   DONE   = déploiement sain → CI continue (smoke prod), pas de rollback.
#   FAILED = déploiement réellement cassé → CI déclenche le rollback.
#
# ─── POURQUOI on ne se fie PAS au seul statut Dokploy ──────────────────────
# Le `compose.deploy` Dokploy est ASYNCHRONE : il queue puis clone+pull+recreate
# en arrière-plan (plusieurs minutes). DEUX faux négatifs observés en prod :
#   1. Un health-check applicatif lancé juste après timeoute pendant le recreate
#      (/api/health momentanément down) → rollback parasite (vécu 3× 2026-06-17).
#   2. Le STATUT du déploiement Dokploy lui-même MENT : Dokploy peut marquer un
#      déploiement `error` alors que le code finit servi et la prod healthy
#      (vécu 2026-06-25, run 28134278276 : status=error à 36s, MAIS prod v11.0.0
#      healthy + bon code servi → le rollback s'est déclenché sur un deploy SAIN ;
#      sauvé par chance que :rollback==:latest neuf cette fois).
#
# → Le seul juge fiable que la prod sert LE BON code = une CONFIRMATION
#   FONCTIONNELLE STABLE de l'application elle-même, en loopback DANS le
#   container prod (bypass Traefik/DNS qui flottent depuis un runner), couplée à
#   la vérif que /api/health.gitSha == SHA qu'on vient de déployer. On combine :
#     a. on poll le statut Dokploy (signal rapide quand tout va bien) ;
#     b. si Dokploy dit `done` → on confirme quand même 3 health 200 + bon SHA ;
#     c. si Dokploy dit `error`/`timeout` → on NE conclut PAS échec : grace
#        fonctionnel de 5 min, 5 health 200 CONSÉCUTIFS (status:ok + clickhouse:ok
#        + gitSha == SHA déployé) avant de trancher. Échec ROUGE (FAILED →
#        rollback) UNIQUEMENT si la prod reste cassée OU sert un AUTRE SHA après
#        ce grace — jamais sur un Dokploy-error menteur seul.
#
# Le SHA servi (health.gitSha, injecté au build via ENV GIT_SHA) est la preuve
# FORTE que LE BON code est déployé — pas juste "un code sain" (le champ version
# n'est pas bumpé sur les commits fix-only). EXPECTED_SHA est passé par la CI.
# Tolérance rétro-compat : si EXPECTED_SHA est vide (déclenchement manuel) OU si
# l'image servie est antérieure au champ gitSha (gitSha absent/'unknown'), on
# retombe sur la santé fonctionnelle seule + un warning explicite — pour ne pas
# bloquer le 1er deploy qui introduit le champ.
set -uo pipefail

COMPOSE_ID="${COMPOSE_ID:-${1:-}}"
[ -n "$COMPOSE_ID" ] || { echo "::error::COMPOSE_ID manquant" >&2; echo FAILED; exit 0; }
EXPECTED_SHA="${EXPECTED_SHA:-}"

DKEY=$(grep '^DOKPLOY_API_KEY=' ~/credentials/.all-creds.env | cut -d= -f2)
INPUT=$(python3 -c "import urllib.parse,json,os; print(urllib.parse.quote(json.dumps({'json':{'composeId':os.environ['COMPOSE_ID']}})))")

# Extrait la valeur d'un champ JSON string simple ("champ":"valeur") du body.
json_str() { echo "$1" | grep -oE "\"$2\":\"[^\"]*\"" | head -1 | sed -E "s/.*:\"([^\"]*)\"/\1/"; }

# Le SHA servi correspond-il au SHA attendu ? (comparaison par préfixe : EXPECTED
# peut être 40-char, gitSha aussi — on compare les 7 premiers, suffisant et
# robuste). Renvoie 0 si match OU si la vérif n'est pas applicable (tolérance).
sha_matches() {
  local served="$1"
  # Pas de SHA attendu (dispatch manuel) → vérif non applicable, on tolère.
  [ -z "$EXPECTED_SHA" ] && return 0
  # Image antérieure au champ gitSha → tolérance + warning (1er deploy du champ).
  if [ -z "$served" ] || [ "$served" = "unknown" ]; then
    echo "  [confirm] health.gitSha absent/'unknown' (image pré-gitSha) → vérif SHA tolérée" >&2
    return 0
  fi
  [ "${served:0:7}" = "${EXPECTED_SHA:0:7}" ]
}

# ─── Confirmation fonctionnelle stable, en loopback dans le container prod ──
# Exige N health 200 CONSÉCUTIFS (status:ok + clickhouse:ok + version présente
# + gitSha == SHA déployé), en interrogeant l'engine sur 127.0.0.1:3000 DANS son
# propre container (pas de Traefik/DNS dans le chemin). Renvoie 0 si la prod est
# fonctionnelle, stable ET sert le bon SHA, 1 sinon.
# Paramètres : $1 = nb de 200 consécutifs requis, $2 = nb max d'essais.
confirm_app_healthy() {
  local need="$1" max_tries="$2" streak=0 i body served
  # Résolution robuste du container engine prod (le suffixe Dokploy peut changer).
  local engine
  engine=$(docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -iE 'analytics-engine.*engine' | grep -v bridge | head -1)
  if [ -z "$engine" ]; then
    echo "  [confirm] container engine prod introuvable" >&2
    return 1
  fi
  for i in $(seq 1 "$max_tries"); do
    body=$(docker exec "$engine" wget -q -O- http://127.0.0.1:3000/api/health 2>/dev/null || echo '')
    served=$(json_str "$body" gitSha)
    if echo "$body" | grep -q '"status":"ok"' \
       && echo "$body" | grep -q '"clickhouse":"ok"' \
       && echo "$body" | grep -q '"version":"' \
       && sha_matches "$served"; then
      streak=$((streak + 1))
      echo "  [confirm] health OK ($streak/$need) gitSha=${served:-?} : ${body:0:80}" >&2
      [ "$streak" -ge "$need" ] && return 0
    else
      if [ "$streak" -gt 0 ] || [ -n "$body" ]; then
        echo "  [confirm] health KO (gitSha servi=${served:-?}, attendu=${EXPECTED_SHA:0:7}) → streak reset" >&2
      fi
      streak=0
    fi
    sleep 6
  done
  return 1
}

# ─── 1. Poll du statut Dokploy : 40 × 12s = 8 min ──────────────────────────
DOK_STATUS=TIMEOUT
for i in $(seq 1 40); do
  ST=$(curl -sf -H "x-api-key: $DKEY" \
    "http://localhost:3000/api/trpc/deployment.allByCompose?input=${INPUT}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['result']['data']['json']; print(d[0]['status'] if d else 'none')" \
    2>/dev/null || echo err)
  echo "[$((i*12))s] dokploy deployment status=$ST" >&2
  case "$ST" in
    done)  DOK_STATUS=DONE;  break ;;
    error) DOK_STATUS=ERROR; break ;;
  esac
  sleep 12
done

# ─── 2. Verdict — la confirmation fonctionnelle prime sur le statut Dokploy ─
if [ "$DOK_STATUS" = "DONE" ]; then
  # Dokploy content : on confirme quand même que l'app sert un health sain
  # (court grace, le recreate est fini). 3×200 consécutifs, ~2 min max.
  if confirm_app_healthy 3 20; then
    echo "✓ Dokploy done + app healthy stable" >&2
    echo DONE; exit 0
  fi
  echo "::error::Dokploy 'done' mais l'app ne sert pas un health sain stable" >&2
  echo FAILED; exit 0
fi

# Dokploy ERROR/TIMEOUT : NE PAS conclure échec sur ce seul signal (il ment).
# Grace fonctionnel de 5 min, 5 health 200 CONSÉCUTIFS exigés (50 essais × 6s),
# avec le bon gitSha servi.
echo "[verdict] Dokploy status=$DOK_STATUS — grace fonctionnel 5 min (5×200 consécutifs + gitSha=${EXPECTED_SHA:0:7} requis)" >&2
if confirm_app_healthy 5 50; then
  echo "::warning::Dokploy a rapporté '$DOK_STATUS' mais la prod sert un health 200 stable (5 consécutifs, clickhouse:ok, bon gitSha) → deploy traité comme RÉUSSI (statut Dokploy non fiable pendant le recreate). Pas de rollback." >&2
  echo DONE; exit 0
fi
echo "::error::Dokploy=$DOK_STATUS ET prod sans health 200 stable servant le bon SHA après 5 min → deploy réellement cassé (ou mauvais code servi)" >&2
echo FAILED; exit 0
