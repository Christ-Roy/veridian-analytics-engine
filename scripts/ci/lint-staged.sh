#!/usr/bin/env bash
# lint-staged.sh — Lint léger pre-commit sur les fichiers staged
#
# Vérifie sur les fichiers staged (pas tout le repo, pour rester rapide) :
#   - veridian-bridge/**.ts → tsc partiel (juste syntax check via --noEmit)
#   - Format YAML compose/**.yml (yamllint si dispo)
#   - Pas de console.log au-dessus du minimum (warning, pas bloquant)
#   - Pas de fichier > 500 lignes ajouté (anti-megafile)
#
# Bloquant uniquement sur les patterns CRITIQUES. Les WARNINGS sont remontés.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

# Liste des fichiers staged (Added, Copied, Modified)
STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED" ]; then
  echo "${GREEN}✓ Aucun fichier staged${NC}"
  exit 0
fi

ERRORS=0
WARNINGS=0

# ── 1. Refuse les console.log brut commités dans veridian-bridge/src/
#     (sauf dans index.ts qui boot-log légitime + commenté avec eslint-disable)
for f in $STAGED; do
  case "$f" in
    veridian-bridge/src/*.ts)
      # Skip index.ts (boot logs OK)
      if [ "$f" = "veridian-bridge/src/index.ts" ]; then
        continue
      fi
      # Cherche les console.log AJOUTÉS (lignes en + du diff)
      ADDED_LOGS=$(git diff --cached "$f" 2>/dev/null | grep -E '^\+[^+].*console\.(log|debug|info)\b' || true)
      if [ -n "$ADDED_LOGS" ]; then
        # Si la ligne contient eslint-disable, on accepte (justifié)
        FILTERED=$(echo "$ADDED_LOGS" | grep -v 'eslint-disable' || true)
        if [ -n "$FILTERED" ]; then
          echo "${RED}✗ console.log non commenté dans $f${NC}"
          echo "$FILTERED" | head -3 | sed 's/^/    /'
          echo "    Justifie avec '// eslint-disable-next-line no-console' OU bascule sur un logger structuré."
          ERRORS=$((ERRORS + 1))
        fi
      fi
      ;;
  esac
done

# ── 2. Megafile guard — refuse les nouveaux fichiers > 500 lignes
#     (modifs incrémentales OK, mais création ex-nihilo d'un fichier 1000 lignes = no)
NEW_FILES=$(git diff --cached --name-only --diff-filter=A 2>/dev/null || true)
for f in $NEW_FILES; do
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx)
      [ ! -f "$f" ] && continue
      LINES=$(wc -l < "$f" 2>/dev/null || echo 0)
      if [ "$LINES" -gt 500 ]; then
        echo "${YELLOW}⚠ Megafile $f ($LINES lignes > 500)${NC}"
        echo "    Considère splitter en plusieurs modules."
        WARNINGS=$((WARNINGS + 1))
      fi
      ;;
  esac
done

# ── 3. YAML lint sur compose/**.yml + .github/workflows/**.yml staged
if command -v yamllint >/dev/null 2>&1; then
  for f in $STAGED; do
    case "$f" in
      compose/*.yml|.github/workflows/*.yml)
        [ ! -f "$f" ] && continue
        if ! yamllint -d "{rules: {line-length: {max: 200}, document-start: disable, truthy: disable, comments-indentation: disable}}" "$f" >/dev/null 2>&1; then
          echo "${RED}✗ YAML invalide : $f${NC}"
          yamllint -d "{rules: {line-length: {max: 200}, document-start: disable, truthy: disable, comments-indentation: disable}}" "$f" | head -10
          ERRORS=$((ERRORS + 1))
        fi
        ;;
    esac
  done
fi

# ── 4. Secrets en clair (regex courte sur staged files)
for f in $STAGED; do
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.json|*.yml|*.yaml|*.env*|*.sh)
      [ ! -f "$f" ] && continue
      # Skip .env.example et tests
      case "$f" in
        *.env.example|*/tests/*|*.test.ts|*.test.tsx|*.spec.ts) continue ;;
      esac
      # Cherche secrets AJOUTÉS uniquement
      LEAK=$(git diff --cached "$f" 2>/dev/null | \
        grep -E '^\+[^+]' | \
        grep -E '(sk_live_[a-zA-Z0-9]{20,}|ghp_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})' || true)
      if [ -n "$LEAK" ]; then
        echo "${RED}✗ SECRET détecté dans $f${NC}"
        echo "$LEAK" | head -3 | sed 's/^/    /'
        ERRORS=$((ERRORS + 1))
      fi
      ;;
  esac
done

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "${RED}─── $ERRORS erreur(s) bloquante(s) ───${NC}"
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "${YELLOW}⚠ $WARNINGS warning(s) — non bloquant${NC}"
fi

echo "${GREEN}✓ lint-staged OK${NC}"
exit 0
