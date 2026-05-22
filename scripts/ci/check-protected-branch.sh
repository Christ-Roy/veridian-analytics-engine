#!/usr/bin/env bash
# check-protected-branch.sh — Refuse les commits/push sur branches protégées
#
# `main` est la branche staminads upstream et ne doit JAMAIS recevoir nos
# commits Veridian. Tout push direct sur main est une faute pro.
#
# Utilisé par les hooks pre-commit et pre-push.

set -euo pipefail

CURRENT_BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"

# Branches strictement read-only pour notre fork
PROTECTED_BRANCHES=(
  "main"
)

for protected in "${PROTECTED_BRANCHES[@]}"; do
  if [ "$CURRENT_BRANCH" = "$protected" ]; then
    cat <<EOF
✗ BRANCHE PROTÉGÉE : $CURRENT_BRANCH

Cette branche suit l'upstream staminads et ne reçoit JAMAIS de commits Veridian.
Bascule sur 'dev', 'staging', ou une branche feature/fix/chore avant de bosser.

  git checkout dev
  git checkout -b chore/<slug>   # ou feat/<slug>, fix/<slug>

Si tu cherches à sync l'upstream :
  git fetch upstream
  git checkout main
  git merge --ff-only upstream/main
  git push origin main           # cas spécial, sync upstream uniquement
EOF
    exit 1
  fi
done

exit 0
