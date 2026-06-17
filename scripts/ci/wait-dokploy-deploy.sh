#!/usr/bin/env bash
# wait-dokploy-deploy.sh — attend la fin du déploiement Dokploy d'un compose.
#
# Le `compose.deploy` Dokploy est ASYNCHRONE : il queue puis clone+pull+recreate
# en arrière-plan (plusieurs minutes). Un health-check applicatif lancé juste
# après timeoute en FAUX NÉGATIF pendant le recreate (/api/health momentanément
# down) → rollback parasite alors que le deploy réussit (vécu 3× le 2026-06-17).
#
# Source de vérité = le STATUT du dernier déploiement Dokploy
# (deployment.allByCompose → done/error), pas une heuristique applicative.
#
# Exécuté SUR le VPS prod (via ssh), lit DOKPLOY_API_KEY dans ~/credentials.
# Usage : COMPOSE_ID=<id> bash wait-dokploy-deploy.sh   (ou $1)
# Émet sur stdout le statut final : DONE | ERROR | TIMEOUT (+ progression stderr).
set -euo pipefail

COMPOSE_ID="${COMPOSE_ID:-${1:-}}"
[ -n "$COMPOSE_ID" ] || { echo "::error::COMPOSE_ID manquant" >&2; echo MISSING; exit 0; }

DKEY=$(grep '^DOKPLOY_API_KEY=' ~/credentials/.all-creds.env | cut -d= -f2)
INPUT=$(python3 -c "import urllib.parse,json,os; print(urllib.parse.quote(json.dumps({'json':{'composeId':os.environ['COMPOSE_ID']}})))")

# 40 × 12s = 8 min de marge (clone + pull images + recreate + migrate-on-boot).
for i in $(seq 1 40); do
  ST=$(curl -sf -H "x-api-key: $DKEY" \
    "http://localhost:3000/api/trpc/deployment.allByCompose?input=${INPUT}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['result']['data']['json']; print(d[0]['status'] if d else 'none')" \
    2>/dev/null || echo err)
  echo "[$((i*12))s] dokploy deployment status=$ST" >&2
  case "$ST" in
    done)  echo DONE;  exit 0 ;;
    error) echo ERROR; exit 0 ;;
  esac
  sleep 12
done
echo TIMEOUT
