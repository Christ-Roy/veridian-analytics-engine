#!/usr/bin/env bash
# Stoppe la stack dev sur dev-pub. Préserve les volumes (données ClickHouse, node_modules).
# Pour wipe complet : scripts/dev-nuke.sh
set -euo pipefail
REPO_DIR="${REPO_DIR:-/opt/dev/analytics-engine}"
cd "${REPO_DIR}"
docker compose --env-file .env.dev -p analytics-engine-dev -f compose/dev.yml down
echo "✓ Stack dev arrêtée (volumes préservés)"
