#!/usr/bin/env bash
# check-structural-changes.sh — Détecte changements structurels
#
# Si le diff vs BASE_REF touche :
#   - Dockerfile / Dockerfile.dev
#   - veridian-bridge/Dockerfile / Dockerfile.dev
#   - compose/*.yml
#   - veridian-bridge/package.json / package-lock.json
#   - sdk/package.json / package-lock.json
#   - .github/workflows/*.yml
# → exit 1 + liste des fichiers + sortie has-structural=true dans GITHUB_OUTPUT
#
# Sinon → exit 0 + has-structural=false
#
# Usage :
#   - CI prod (BASE_REF=HEAD~1 sur push staging, ou origin/staging sur PR)
#   - Manuel (BASE_REF=origin/dev pour la branche courante)

set -euo pipefail

BASE_REF="${BASE_REF:-HEAD~1}"

STRUCTURAL_PATTERNS=(
  '^Dockerfile$'
  '^Dockerfile\.[^/]+$'
  '^veridian-bridge/Dockerfile$'
  '^veridian-bridge/Dockerfile\.[^/]+$'
  '^compose/'
  '^docker-compose\.yml$'
  '^docker-compose\.[^/]+\.yml$'
  '^veridian-bridge/package\.json$'
  '^veridian-bridge/package-lock\.json$'
  '^sdk/package\.json$'
  '^sdk/package-lock\.json$'
  '^api/package\.json$'
  '^api/package-lock\.json$'
  '^\.github/workflows/'
)

CHANGED=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || true)

if [ -z "$CHANGED" ]; then
  echo "✓ Pas de changement détecté"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "has-structural=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

STRUCTURAL_CHANGED=""
for pattern in "${STRUCTURAL_PATTERNS[@]}"; do
  match=$(echo "$CHANGED" | grep -E "$pattern" || true)
  if [ -n "$match" ]; then
    STRUCTURAL_CHANGED="${STRUCTURAL_CHANGED}${match}
"
  fi
done

STRUCTURAL_CHANGED=$(printf "%b" "$STRUCTURAL_CHANGED" | sort -u | grep -v '^$' || true)

if [ -z "$STRUCTURAL_CHANGED" ]; then
  echo "✓ Aucun fichier structurel modifié"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "has-structural=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "⚠ Fichiers structurels modifiés :"
echo "$STRUCTURAL_CHANGED" | sed 's/^/  - /'
echo
echo "→ Staging vert récent requis avant promotion main"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "has-structural=true" >> "$GITHUB_OUTPUT"
exit 1
