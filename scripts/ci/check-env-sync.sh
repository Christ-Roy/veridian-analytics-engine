#!/usr/bin/env bash
# check-env-sync.sh — Détecte le drift entre process.env.X / .env.example / compose
#
# Empêche le scénario où :
#   - un dev ajoute `process.env.NEW_VAR` dans src/
#   - .env.example pas mis à jour
#   - compose/base.yml pas mis à jour
#   → en prod la var manque, app crash ou mode dégradé silencieux
#
# Vérifie :
#   1. Toute var lue via process.env.X dans veridian-bridge/src/ doit
#      apparaître dans veridian-bridge/.env.example (en placeholder ok)
#   2. Toute var listée dans .env.example doit être référencée soit dans
#      le code soit dans compose/*.yml
#
# Skip d'urgence : SKIP_ENV_SYNC=1 (à éviter, ouvre la porte aux régressions)

set -euo pipefail

if [ "${SKIP_ENV_SYNC:-0}" = "1" ]; then
  echo "⚠ check-env-sync skipped (SKIP_ENV_SYNC=1)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

ENV_EXAMPLE="veridian-bridge/.env.example"
SRC_DIR="veridian-bridge/src"

if [ ! -f "$ENV_EXAMPLE" ]; then
  echo "⚠ $ENV_EXAMPLE absent, check-env-sync skip"
  exit 0
fi

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

# Variables utilisées dans le code (process.env.X)
CODE_VARS=$(grep -rhE 'process\.env\.[A-Z_][A-Z0-9_]+' "$SRC_DIR" 2>/dev/null | \
  grep -oE 'process\.env\.[A-Z_][A-Z0-9_]+' | \
  sed 's/^process\.env\.//' | \
  sort -u)

# Variables déclarées dans .env.example (lignes "VAR=...")
EXAMPLE_VARS=$(grep -E '^[A-Z_][A-Z0-9_]+=' "$ENV_EXAMPLE" 2>/dev/null | \
  cut -d= -f1 | sort -u)

# Variables référencées dans les composes (${VAR} ou ${VAR:-default} ou ${VAR:?...})
COMPOSE_VARS=$(grep -rhoE '\$\{[A-Z_][A-Z0-9_]+(:[?\-][^}]*)?\}' compose/ 2>/dev/null | \
  sed -E 's/^\$\{([A-Z_][A-Z0-9_]+).*/\1/' | sort -u)

MISSING_IN_EXAMPLE=$(comm -23 <(echo "$CODE_VARS") <(echo "$EXAMPLE_VARS") || true)
MISSING_IN_CODE=$(comm -23 <(echo "$EXAMPLE_VARS") <(echo -e "$CODE_VARS\n$COMPOSE_VARS" | sort -u) || true)

# Vars système (héritées du runtime, pas à déclarer)
SYS_VARS_REGEX='^(NODE_ENV|PATH|HOME|USER|TZ|LANG|LC_.*)$'

ERRORS=0

for v in $MISSING_IN_EXAMPLE; do
  # Skip les vars système
  if echo "$v" | grep -qE "$SYS_VARS_REGEX"; then
    continue
  fi
  echo "${RED}✗ $v lue dans src/ mais absente de $ENV_EXAMPLE${NC}"
  ERRORS=$((ERRORS + 1))
done

# Pour MISSING_IN_CODE, on est plus tolérant : juste WARN, car certaines vars
# peuvent être destinées à staminads (PORT, etc.) et donc pas dans le code bridge
for v in $MISSING_IN_CODE; do
  # Skip si la var est dans compose/ (=> destinée à staminads ou clickhouse)
  if echo "$COMPOSE_VARS" | grep -Fxq "$v"; then
    continue
  fi
  echo "${YELLOW}⚠ $v déclarée dans $ENV_EXAMPLE mais utilisée nulle part (code ou compose)${NC}"
done

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "${RED}─── $ERRORS variable(s) lue(s) sans déclaration dans .env.example ───${NC}"
  echo "Ajoute-les à $ENV_EXAMPLE avec un placeholder, sinon la prod va crasher."
  exit 1
fi

echo "${GREEN}✓ ENV sync OK${NC}"
exit 0
