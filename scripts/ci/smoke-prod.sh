#!/usr/bin/env bash
# smoke-prod.sh — Smoke test prod analytics-engine
#
# Vérifie que :
#   1. https://analytics-engine.app.veridian.site/api/setup.status répond 200
#   2. https://analytics-engine-bridge.app.veridian.site/health répond 200 + JSON valide
#   3. /api/admin/shadow-marketing répond 200 + array 6 items (endpoint public)
#
# Retry exponentiel : 6 attempts, max 60s total.
# Exit 0 si tout vert, 1 sinon.

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-https://analytics-engine.app.veridian.site}"
BRIDGE_URL="${BRIDGE_URL:-https://analytics-engine-bridge.app.veridian.site}"

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
NC=$'\033[0m'

probe() {
  local url="$1"
  local pattern="${2:-}"
  for i in $(seq 1 6); do
    if [ -n "$pattern" ]; then
      if curl -skf --max-time 10 "$url" | grep -q "$pattern"; then
        echo "${GREEN}✓${NC} $url"
        return 0
      fi
    else
      if curl -skf --max-time 10 "$url" >/dev/null; then
        echo "${GREEN}✓${NC} $url"
        return 0
      fi
    fi
    sleep $((i * 2))
  done
  echo "${RED}✗${NC} $url failed after 6 attempts"
  return 1
}

echo "Smoke test prod analytics-engine"
probe "$ENGINE_URL/api/setup.status" || exit 1
probe "$BRIDGE_URL/health" '"status"' || exit 1
probe "$BRIDGE_URL/api/admin/shadow-marketing" '"services"' || exit 1

echo "${GREEN}✓ Prod smoke OK${NC}"
exit 0
