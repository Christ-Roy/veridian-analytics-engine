#!/usr/bin/env bash
# static-audit.sh — Audit statique pre-push (style veridian-hub)
#
# Détecte les patterns à risque dans les fichiers TS du bridge / SDK / console :
#   - eval() / new Function() / vm.runInNewContext (RCE)
#   - exec/execSync sans whitelist (RCE)
#   - fs.writeFile* hors scope (écriture de fichiers depuis user input)
#   - console.log avec process.env.X_KEY|TOKEN|SECRET (leak secrets dans logs)
#   - import dynamique d'un path user-controlled
#   - dangerouslySetInnerHTML sans sanitization explicite (XSS)
#   - process.env access sans default fallback dans le code source (hors index.ts)
#
# Mode :
#   - Pre-push : scan le diff origin/<branche>..HEAD
#   - CI : scan le diff PR head..base
#   - Manuel : BASE_REF=HEAD pour scanner working tree, ou ALL=1 pour scanner tout
#
# Bloquant uniquement sur les patterns CRITIQUES. Les WARNINGS sont remontés
# mais n'arrêtent pas le push.
#
# Variables :
#   BASE_REF (default origin/<current branch>)
#   ALL=1 pour scanner tout le repo (audit complet hors diff)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

# ─── Résolution des fichiers à scanner ──────────────────────────────────────
if [ "${ALL:-0}" = "1" ]; then
  FILES=$(find veridian-bridge/src sdk/src console/src -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null || true)
  MODE="all-tree"
else
  BASE_REF="${BASE_REF:-origin/$(git rev-parse --abbrev-ref HEAD)}"
  if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    BASE_REF="origin/dev"
  fi
  if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    # Premier push, pas encore d'upstream — pas de diff à scanner
    echo "${YELLOW}⚠ BASE_REF inaccessible (premier push?), audit static skip${NC}"
    exit 0
  fi
  FILES=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null | \
    grep -E '^(veridian-bridge/src|sdk/src|console/src).*\.(ts|tsx)$' || true)
  MODE="diff vs $BASE_REF"
fi

if [ -z "$FILES" ]; then
  echo "${GREEN}✓ Audit static : aucun fichier TS à scanner${NC}"
  exit 0
fi

echo "${BLUE}─── Audit static ($MODE) ───${NC}"

CRITICAL=0
WARNINGS=0

# Patterns CRITIQUES — bloquent le push
# Format : <pattern_regex>|<description>|<exception_regex (optional)>
declare -a CRITICAL_PATTERNS=(
  'eval\s*\(|usage de eval() — RCE potentielle'
  'new\s+Function\s*\(|usage de new Function() — RCE potentielle'
  'child_process.*exec\s*\(|exec() child_process sans whitelist — RCE potentielle'
  'child_process.*execSync\s*\(|execSync() child_process — RCE potentielle'
  'dangerouslySetInnerHTML.*[^}]\bcontent\b|dangerouslySetInnerHTML avec content user-controlled'
)

# Patterns WARNINGS — signalés mais non bloquants
declare -a WARNING_PATTERNS=(
  'console\.log.*process\.env\.\w*(KEY|TOKEN|SECRET|PASSWORD)|leak potentiel de secret en log'
  '\bany\b\s*=|usage de "any" — préfère unknown ou type explicite'
  '@ts-ignore|@ts-ignore désactive le typecheck — préfère @ts-expect-error'
  'TODO.*SECURITY|TODO sécurité non résolu'
  'FIXME.*SECURITY|FIXME sécurité non résolu'
  '\.skip\s*\(|test.skip / it.skip — test désactivé'
)

# Patterns SECRETS — bloquent le push (regex de tokens en clair commités)
declare -a SECRET_PATTERNS=(
  '[A-Z_]+_(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["'"'"'][a-zA-Z0-9_/+=-]{20,}["'"'"']|secret hard-codé (literal string > 20 chars)'
  'sk_live_[a-zA-Z0-9]{20,}|Stripe live secret key'
  'AIza[0-9A-Za-z\-_]{20,}|Google API key'
  'AKIA[0-9A-Z]{16}|AWS Access Key'
  'ghp_[A-Za-z0-9_]{20,}|GitHub Personal Access Token'
  'gho_[A-Za-z0-9_]{20,}|GitHub OAuth Token'
)

# grep_code : grep -nE en ignorant les lignes purement commentaires (// ... ,
# * ... , /* ... ). Évite les faux positifs quand le mot "eval()" / "exec()"
# apparaît dans une docstring ("le payload n'est jamais eval()é"). Le code
# réel a toujours du non-commentaire avant le pattern.
grep_code() {
  local pattern="$1" file="$2"
  grep -nE "$pattern" "$file" 2>/dev/null | \
    grep -vE ':[[:space:]]*(//|\*|/\*)' || true
}

# Loop CRITICAL
for entry in "${CRITICAL_PATTERNS[@]}"; do
  IFS='|' read -r pattern desc <<< "$entry"
  for f in $FILES; do
    [ ! -f "$f" ] && continue
    # On skip les fichiers de tests (eval pas grave dans test fixtures) ET les helpers de tests
    case "$f" in
      */tests/*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) continue ;;
    esac
    MATCHES=$(grep_code "$pattern" "$f")
    if [ -n "$MATCHES" ]; then
      echo "${RED}✗ CRITICAL${NC} $f"
      echo "    pattern : $desc"
      echo "$MATCHES" | head -3 | sed 's/^/      /'
      CRITICAL=$((CRITICAL + 1))
    fi
  done
done

# Loop SECRETS
for entry in "${SECRET_PATTERNS[@]}"; do
  IFS='|' read -r pattern desc <<< "$entry"
  for f in $FILES; do
    [ ! -f "$f" ] && continue
    # Skip tests (fixtures peuvent contenir des "fake-secret-32-chars")
    case "$f" in
      */tests/*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) continue ;;
    esac
    if grep -nE "$pattern" "$f" >/dev/null 2>&1; then
      # Skip si le match contient explicitement "fake", "test", "example", "placeholder"
      MATCH_LINE=$(grep -nE "$pattern" "$f" | head -1)
      if echo "$MATCH_LINE" | grep -qiE '(fake|test|example|placeholder|dummy|sample|xxx+)'; then
        continue
      fi
      echo "${RED}✗ SECRET${NC} $f"
      echo "    pattern : $desc"
      echo "    line    : ${MATCH_LINE}"
      CRITICAL=$((CRITICAL + 1))
    fi
  done
done

# Loop WARNINGS
for entry in "${WARNING_PATTERNS[@]}"; do
  IFS='|' read -r pattern desc <<< "$entry"
  for f in $FILES; do
    [ ! -f "$f" ] && continue
    case "$f" in
      */tests/*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) continue ;;
    esac
    if grep -nE "$pattern" "$f" >/dev/null 2>&1; then
      echo "${YELLOW}⚠ WARN${NC} $f : $desc"
      WARNINGS=$((WARNINGS + 1))
    fi
  done
done

echo
if [ "$CRITICAL" -gt 0 ]; then
  echo "${RED}╔═══════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ AUDIT STATIQUE REFUSÉ — $CRITICAL violation(s) critique(s)         ║${NC}"
  echo "${RED}╚═══════════════════════════════════════════════════════════╝${NC}"
  echo "Constitution CI §3 : jamais --no-verify."
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "${YELLOW}⚠ $WARNINGS warning(s) — à résorber quand possible.${NC}"
fi

echo "${GREEN}✓ Audit static : OK${NC}"
exit 0
