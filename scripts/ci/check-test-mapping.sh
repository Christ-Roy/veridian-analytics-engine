#!/usr/bin/env bash
# check-test-mapping.sh — Veridian Analytics Engine (fork staminads)
#
# Variante du script Veridian standard, adaptée aux scopes du fork :
#   - veridian-bridge/src/**.ts → veridian-bridge/tests/*.test.ts (notre code)
#   - api/src/**/*.ts           → api/src/**/*.spec.ts OU api/test/*.e2e-spec.ts
#   - sdk/src/*.ts              → sdk/src/*.test.ts OU sdk/tests/e2e/*.spec.ts
#   - compose/*.yml             → couverts par test-coverage-map.yaml
#
# Comportement :
#   1. Liste les fichiers modifiés vs BASE_REF (default: origin/staging)
#   2. Pour chaque fichier dans scope critique :
#      - Cherche test colocalisé selon convention
#      - Sinon cherche dans test-coverage-map.yaml
#      - Sinon → bloque
#   3. Exit 1 sur le moindre manquement
#
# Usage :
#   ./scripts/ci/check-test-mapping.sh                         # pre-push
#   BASE_REF=origin/staging ./scripts/ci/check-test-mapping.sh  # CI
#   BASE_REF=HEAD ./scripts/ci/check-test-mapping.sh           # working tree
#
set -euo pipefail

BASE_REF="${BASE_REF:-origin/staging}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

# ─── Diff ────────────────────────────────────────────────────────────────────
if [ "$BASE_REF" = "HEAD" ]; then
  CHANGED=$(git diff --name-only HEAD; git diff --cached --name-only)
  CHANGED=$(echo "$CHANGED" | sort -u | grep -v '^$' || true)
else
  if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    echo "${YELLOW}⚠ $BASE_REF inaccessible, fallback HEAD~1${NC}"
    BASE_REF="HEAD~1"
  fi
  CHANGED=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || true)
fi

if [ -z "$CHANGED" ]; then
  echo "${GREEN}✓ Aucun fichier modifié${NC}"
  exit 0
fi

# ─── Allowlist tests-pending ────────────────────────────────────────────────
PENDING_FILE="tests-pending.txt"
PENDING=""
if [ -f "$PENDING_FILE" ]; then
  PENDING=$(grep -v '^\s*#' "$PENDING_FILE" 2>/dev/null | grep -v '^\s*$' || true)
fi

is_pending() {
  local file="$1"
  if [ -n "$PENDING" ]; then
    echo "$PENDING" | grep -Fxq "$file" 2>/dev/null
  else
    return 1
  fi
}

# ─── Coverage map (YAML) ────────────────────────────────────────────────────
# Lookup inline plus bas dans la boucle principale via awk + grep. La logique
# coverage-map est implémentée à la fin du script (recherche du bloc sources+
# covered_by et vérification qu'au moins un covered_by est dans CHANGED).
COVERAGE_MAP="test-coverage-map.yaml"

# ─── Détermination du test attendu par convention ───────────────────────────
canonical_test_for() {
  local file="$1"
  case "$file" in
    veridian-bridge/src/*.ts)
      # veridian-bridge/src/app.ts → veridian-bridge/tests/{config,health,auth,provision-tenant,track-test,analytics}.test.ts
      # Pas de mapping 1-pour-1 simple (app.ts couvert par plusieurs fichiers).
      # On accepte que TOUT fichier sous veridian-bridge/tests/*.test.ts soit modifié.
      echo "veridian-bridge/tests/" ;;
    api/src/*/dto/*.dto.ts|api/src/*/entities/*.entity.ts)
      # DTOs et entities : pas de test direct exigé (couvert par les controllers)
      echo "SKIP" ;;
    api/src/*/[!.]*.service.ts)
      # service.ts → service.spec.ts colocalisé
      echo "${file%.ts}.spec.ts" ;;
    api/src/*/[!.]*.controller.ts)
      # controller.ts → e2e correspondant dans api/test/
      local base
      base=$(basename "$file" .controller.ts)
      echo "api/test/${base}.e2e-spec.ts" ;;
    api/src/migrations/*.ts)
      # migrations → migrations.e2e-spec.ts global
      echo "api/test/migrations.e2e-spec.ts" ;;
    api/src/*.ts)
      # autres fichiers api/src → coverage-map ou rien
      echo "" ;;
    sdk/src/*.ts)
      # sdk/src/X.ts → sdk/src/X.test.ts (colocalisé) OU tests/
      echo "sdk/tests/" ;;
    # ─── Console : code partagé critique (incident prod 2026-06-29) ───
    # Lib de formatage, widgets dashboard et hooks consomment des réponses
    # API ClickHouse (valeurs string/undefined) et alimentent le rendu. Un
    # crash `undefined.toFixed()` y avait planté TOUS les workspaces sans
    # qu'aucun test ne l'exige (la console était SKIP par ce mapping). On
    # exige désormais un test colocalisé `<dir>/__tests__/<base>.test.tsx`.
    # Les 87 fichiers legacy non couverts vivent dans tests-pending.txt
    # (dette déclarée, à résorber). Hors scope : routes/, types/, _archive/,
    # _optional-features/ (couverts par e2e ou gelés).
    console/src/lib/*.ts|console/src/lib/*.tsx|console/src/components/**/*.tsx|console/src/hooks/*.ts|console/src/hooks/*.tsx)
      # Mapping "dossier" : on accepte qu'un test du __tests__ colocalisé soit
      # modifié dans la même PR (même convention que bridge/sdk ci-dessus).
      local dir
      dir=$(dirname "$file")
      echo "${dir}/__tests__/" ;;
    *) echo "SKIP" ;;
  esac
}

# ─── Boucle de vérification ─────────────────────────────────────────────────
echo "${BLUE}─── Test-mapping check vs ${BASE_REF} ───${NC}"
echo "Fichiers modifiés : $(echo "$CHANGED" | wc -l)"

MISSING=0
for file in $CHANGED; do
  # Skip non-source
  # shellcheck disable=SC2221,SC2222
  case "$file" in
    *.md|*.yaml|*.yml|*.json|.gitignore|.dockerignore|.trivyignore|Dockerfile*|*.sh|.github/*|scripts/*|*spec*|*tests-pending*|releases/*|*test*)
      continue ;;
  esac

  if is_pending "$file"; then
    echo "${YELLOW}⊘ $file${NC} (dans tests-pending.txt — dette acceptée)"
    continue
  fi

  expected=$(canonical_test_for "$file")

  if [ "$expected" = "SKIP" ] || [ -z "$expected" ]; then
    continue
  fi

  # Cas mapping "dossier" : on accepte qu'un test du dossier soit dans CHANGED
  if [[ "$expected" == */ ]]; then
    if echo "$CHANGED" | grep -q "^${expected}"; then
      echo "${GREEN}✓${NC} $file → fichier de tests dans $expected modifié"
      continue
    fi
  else
    # Cas mapping 1-pour-1
    if echo "$CHANGED" | grep -Fxq "$expected"; then
      echo "${GREEN}✓${NC} $file → $expected modifié"
      continue
    fi
    if [ -f "$expected" ]; then
      echo "${YELLOW}⚠${NC} $file modifié mais $expected pas changé dans cette PR"
    fi
  fi

  # Fallback : coverage-map
  if [ -f "$COVERAGE_MAP" ] && grep -Fq "$file" "$COVERAGE_MAP"; then
    # Cherche grossier : si au moins un covered_by est dans CHANGED
    covered_lines=$(awk -v target="$file" '
      $0 ~ "- " target { in_match=1; next }
      in_match && /^  covered_by:/ { in_cov=1; next }
      in_cov && /^    - / { print; next }
      in_cov && /^  reason:/ { exit }
    ' "$COVERAGE_MAP" | sed 's/^    - //')
    if [ -n "$covered_lines" ]; then
      hit=0
      while IFS= read -r cov; do
        if echo "$CHANGED" | grep -Fxq "$cov"; then
          hit=1; break
        fi
      done <<< "$covered_lines"
      if [ "$hit" = "1" ]; then
        echo "${GREEN}✓${NC} $file → couvert par coverage-map (au moins un covered_by modifié)"
        continue
      fi
      echo "${RED}✗${NC} $file modifié mais aucun covered_by déclaré dans $COVERAGE_MAP n'est modifié"
      echo "    covered_by attendus :"
      echo "$covered_lines" | sed 's/^/      - /'
      MISSING=$((MISSING + 1))
      continue
    fi
  fi

  echo "${RED}✗${NC} $file modifié sans test correspondant"
  echo "    Attendu : $expected"
  echo "    Solutions :"
  echo "      1. Ajouter le test à : $expected"
  echo "      2. Déclarer dans $COVERAGE_MAP (sources / covered_by / reason)"
  echo "      3. Ajouter à $PENDING_FILE (dette transitoire, à résorber)"
  MISSING=$((MISSING + 1))
done

if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "${RED}─── $MISSING fichier(s) critique(s) sans test correspondant ───${NC}"
  echo "Push refusé. Constitution CI §3 : pas de --no-verify."
  exit 1
fi

echo "${GREEN}─── Test-mapping : ALL GREEN ───${NC}"
exit 0
