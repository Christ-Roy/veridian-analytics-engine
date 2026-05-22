#!/usr/bin/env bash
# check-conventional-commits.sh — Validation Conventional Commits
#
# Vérifie que tous les commits du push respectent le format Conventional Commits.
#
# Format attendu :
#   <type>(<scope>)?: <subject>
#
# Types autorisés :
#   feat, fix, chore, docs, refactor, test, ci, build, perf, style, revert
#
# Règles :
#   - subject ≤ 72 chars
#   - type minuscule
#   - subject pas vide
#   - scope optionnel mais entre () si présent
#
# Skippe les commits "Merge ..." (merge commits) et "Revert ..." (commits revert).
#
# Variables :
#   BASE_REF (default origin/<branche>)
#
# Exit 0 si tous les commits valides, 1 sinon.

set -euo pipefail

BASE_REF="${BASE_REF:-origin/$(git rev-parse --abbrev-ref HEAD)}"
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  # Premier push — pas de comparaison possible
  echo "⚠ BASE_REF inaccessible (premier push?), conventional-commits skip"
  exit 0
fi

# Récupère les subjects de tous les commits du range, séparés par |
COMMITS=$(git log "$BASE_REF"..HEAD --format='%H|%s' 2>/dev/null || true)

if [ -z "$COMMITS" ]; then
  echo "✓ Aucun nouveau commit à valider"
  exit 0
fi

CONV_REGEX='^(feat|fix|chore|docs|refactor|test|ci|build|perf|style|revert)(\([a-z0-9_/.-]+\))?!?: .+$'
MAX_LEN=72

INVALID=0
while IFS='|' read -r sha subject; do
  [ -z "$subject" ] && continue
  # Skip merge / revert auto
  case "$subject" in
    "Merge "*) continue ;;
    "Revert \"Revert "*) continue ;;
  esac
  # Format check
  if ! echo "$subject" | grep -qE "$CONV_REGEX"; then
    echo "✗ ${sha:0:7} format invalide"
    echo "    subject : $subject"
    echo "    attendu : <type>(<scope>)?: <subject> où type ∈ feat|fix|chore|docs|refactor|test|ci|build|perf|style|revert"
    INVALID=$((INVALID + 1))
    continue
  fi
  # Length check
  LEN=${#subject}
  if [ "$LEN" -gt "$MAX_LEN" ]; then
    echo "✗ ${sha:0:7} subject trop long ($LEN chars > $MAX_LEN)"
    echo "    subject : $subject"
    INVALID=$((INVALID + 1))
  fi
done <<< "$COMMITS"

if [ "$INVALID" -gt 0 ]; then
  echo ""
  echo "─── $INVALID commit(s) au format invalide ───"
  echo "Fix : git rebase -i $BASE_REF puis reword les commits fautifs."
  echo "Exemple valide : 'feat(bridge): add /api/admin/tenant/:id/score'"
  exit 1
fi

echo "✓ Tous les commits respectent Conventional Commits"
exit 0
