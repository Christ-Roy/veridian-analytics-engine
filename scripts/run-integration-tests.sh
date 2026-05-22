#!/usr/bin/env bash
# ============================================================================
# run-integration-tests.sh — lance les tests d'intégration du bridge EN LOCAL
# ============================================================================
#
# Démarre les services éphémères de `compose/test.yml` (Postgres + ClickHouse),
# attend qu'ils soient healthy, applique les migrations Prisma, lance les
# `*.integration.test.ts`, puis TEARDOWN (down -v) — même en cas d'échec.
#
# Appelé par : `npm run test:integration:local` (depuis veridian-bridge/).
# La CI n'utilise PAS ce script : elle a ses propres `services:` GitHub Actions.
#
# Usage :
#   ./scripts/run-integration-tests.sh            # full cycle up → test → down
#   KEEP_UP=1 ./scripts/run-integration-tests.sh  # garde les services up après
# ============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/compose/test.yml"
BRIDGE_DIR="$REPO_ROOT/veridian-bridge"

# Coordonnées exposées par compose/test.yml (ports décalés).
export BRIDGE_TEST_DATABASE_URL="postgresql://bridge_test:bridge_test_pwd@127.0.0.1:55432/veridian_bridge_test"
export CLICKHOUSE_TEST_HOST="http://127.0.0.1:58123"

cleanup() {
  if [ "${KEEP_UP:-0}" = "1" ]; then
    echo "── KEEP_UP=1 : services laissés up (down manuel : docker compose -f compose/test.yml down -v) ──"
  else
    echo "── Teardown services de test ──"
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "── Démarrage des services de test (Postgres + ClickHouse) ──"
docker compose -f "$COMPOSE_FILE" up -d --wait

echo "── Services healthy ──"
docker compose -f "$COMPOSE_FILE" ps

echo "── Lancement des tests d'intégration ──"
cd "$BRIDGE_DIR"
npm run test:integration
