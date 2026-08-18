#!/usr/bin/env bash
# Veridian Analytics Engine — activation des hooks Husky
#
# POURQUOI CE SCRIPT EXISTE
#
# Ce dépôt n'a pas de `package.json` à la racine : il n'y a donc aucun
# `npm install` racine, et donc aucun `prepare: husky` pour câbler les hooks.
# Le seul câblage possible est `core.hooksPath`, qui vit dans `.git/config` —
# c'est-à-dire un réglage LOCAL, non versionné, qui n'existe pas après un
# `git clone` frais.
#
# Le mode de panne est silencieux, et c'est ce qui le rend dangereux : sans
# `core.hooksPath`, git ne cherche les hooks que dans `.git/hooks/`, ne trouve
# rien, et pousse SANS RIEN DIRE. On croit être protégé par un pre-push
# ultra-strict alors qu'on pousse à nu depuis des semaines. Constaté le
# 2026-08-18 sur ce dépôt.
#
# À lancer une fois par clone (et par worktree neuf, si le clone est neuf) :
#     ./scripts/ci/install-hooks.sh
#
# Vérifier à tout moment :
#     git config --get core.hooksPath   # doit afficher .husky

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ ! -d .husky ]; then
  echo "✗ .husky/ introuvable à la racine du dépôt ($REPO_ROOT)" >&2
  exit 1
fi

git config core.hooksPath .husky

# Les hooks sont invoqués directement par git : sans bit exécutable, git les
# ignore (silencieusement, là encore).
chmod +x .husky/pre-commit .husky/commit-msg .husky/pre-push

echo "✓ core.hooksPath = $(git config --get core.hooksPath)"
echo "✓ hooks actifs   : $(ls .husky | tr '\n' ' ')"
