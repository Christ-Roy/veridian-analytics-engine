#!/usr/bin/env bash
# check-protected-branch.sh — Refuse les commits/push directs sur branches protégées
#
# Modèle de branches (refonte 2026-05-22) : main ← staging.
#   - `main`    : photo de prod. On n'y commit jamais en direct — on y arrive
#                 par promotion fast-forward depuis `staging`.
#   - `staging` : trunk de travail. C'est ici qu'on bosse (commits directs OK).
#
# `main` est donc protégé : tout commit direct dessus est une faute pro.
# La sync de l'upstream staminads se fait via le remote `upstream`, pas via
# une branche locale qui le miroir.
#
# Utilisé par les hooks pre-commit et pre-push.

set -euo pipefail

CURRENT_BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"

# Branches sur lesquelles on ne commit jamais en direct
PROTECTED_BRANCHES=(
  "main"
)

for protected in "${PROTECTED_BRANCHES[@]}"; do
  if [ "$CURRENT_BRANCH" = "$protected" ]; then
    cat <<EOF
✗ BRANCHE PROTÉGÉE : $CURRENT_BRANCH

'main' est la photo de prod : on n'y commit jamais en direct. La prod reçoit
du code par promotion fast-forward depuis 'staging'.

Bascule sur 'staging' ou une branche feature/fix/chore avant de bosser :

  git checkout staging
  git checkout -b chore/<slug>   # ou feat/<slug>, fix/<slug>

Pour promouvoir staging → main (déploiement prod) :
  git checkout main
  git merge --ff-only origin/staging
  git push origin main

Pour sync l'upstream staminads :
  git fetch upstream
  git merge upstream/main         # depuis staging, puis résoudre/tester
EOF
    exit 1
  fi
done

exit 0
