#!/usr/bin/env bash
# check-engine-api.sh — Gate pre-push pour l'engine NestJS (api/).
#
# POURQUOI : le pre-push husky validait le bridge et le SDK mais JAMAIS api/
# (l'engine). Une dep parasite ou une erreur TS dans api/src passait le
# pre-push ALL GREEN et ne cassait qu'en CI (vécu 2026-06-17 : `zod` importé
# absent de api/package.json → `Cannot find module 'zod'` au npm ci propre ;
# TS1272/TS7006 dans src/voip/). Ticket 2026-06-17-pre-push-husky-rate-tsc-build.
#
# CONTRAINTE : machine de Robert = 7.6Gi RAM, ZÉRO build lourd local. Donc :
#   - Check 1 (TOUJOURS) : résolution statique des imports non-relatifs des
#     fichiers api/src touchés contre api/package.json. Ultra-léger (grep),
#     attrape la classe "dep manquante" (le bug zod) même SANS node_modules.
#   - Check 2 (SI api/node_modules existe déjà) : `tsc --noEmit` incrémental
#     (skipLibCheck=true + incremental=true dans tsconfig → léger après le
#     1er run). On n'INSTALLE PAS les deps si elles manquent — la CI s'en
#     charge ; on signale juste que le typecheck complet est délégué.
#
# Idempotent / rapide : ne fait rien si le diff ne touche aucun fichier
# api/src/**.ts. Override d'urgence : SKIP_ENGINE_API=1 (à éviter).

set -euo pipefail

if [ "${SKIP_ENGINE_API:-0}" = "1" ]; then
  echo "⚠ check-engine-api skipped (SKIP_ENGINE_API=1)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

# Base introuvable => on REFUSE, on ne se rabat pas sur HEAD~1 en silence.
# Vécu le 2026-08-18 : origin/staging supprimée du remote, ce script comparait
# un seul commit et annonçait « aucun fichier api/src touché » sur un push qui
# modifiait api/src/sso/. Un check qui se dégrade tout seul ment.
BASE_REF="${BASE_REF:-origin/staging}"
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  echo "${RED}✗ check-engine-api : base '$BASE_REF' introuvable.${NC}" >&2
  echo "  Refus de comparer sur une base approximative (git fetch origin ?)." >&2
  echo "  Base explicite : BASE_REF=origin/main $0" >&2
  exit 1
fi

# Fichiers api/src/*.ts touchés (Added/Copied/Modified/Renamed), hors specs.
CHANGED_API_TS="$(git diff --name-only --diff-filter=ACMR "$BASE_REF"..HEAD -- 'api/src/**/*.ts' 2>/dev/null \
  | grep -v '\.spec\.ts$' || true)"

if [ -z "$CHANGED_API_TS" ]; then
  echo "  engine api: aucun fichier api/src touché → skip"
  exit 0
fi

echo "─── Pre-push : engine api (fichiers touchés sous api/src) ───"

API_PKG="api/package.json"
if [ ! -f "$API_PKG" ]; then
  echo "${YELLOW}⚠ $API_PKG absent, check-engine-api skip${NC}"
  exit 0
fi

# ─── Check 1 : imports non-relatifs résolvent dans api/package.json ──────────
# Liste des packages déclarés (dependencies + devDependencies), un par ligne.
DECLARED="$(node -e '
  const p = require("./api/package.json");
  const names = Object.keys({ ...(p.dependencies||{}), ...(p.devDependencies||{}) });
  process.stdout.write(names.join("\n"));
')"

# Builtins Node (avec ou sans préfixe node:). Liste figée suffisante ici.
NODE_BUILTINS="assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder timers tls trace_events tty url util v8 vm worker_threads zlib"

# Packages TOUJOURS présents en node_modules car dépendance DIRECTE d'un package
# déclaré (framework). Différent du cas "dep absente" (le bug zod 2026-06-17) :
# ici le module se résout au 'npm ci' propre, donc PAS de 'Cannot find module'.
#   - express : dépendance directe de @nestjs/platform-express (déclaré) ; importé
#     en type-only (`import type { Request/Response }`) dans 13 fichiers api/src.
# Si tu ajoutes ici, vérifie que le provider est bien déclaré dans api/package.json
# ET tire le package dans api/package-lock.json (sinon ce n'est PAS transitif sûr).
KNOWN_TRANSITIVE="express"

missing=""
# Récupère les specifiers d'import/require non-relatifs des fichiers touchés.
# - `from '<x>'` (ES import) et `require('<x>')`
# Réduit au nom de package racine (gère le scope @scope/pkg et les sous-chemins).
for f in $CHANGED_API_TS; do
  [ -f "$f" ] || continue
  specifiers="$(grep -hoE "(from|require\()[[:space:]]*['\"][^'\"]+['\"]" "$f" 2>/dev/null \
    | grep -oE "['\"][^'\"]+['\"]" \
    | tr -d "\"'" || true)"
  for spec in $specifiers; do
    case "$spec" in
      .*|/*) continue ;;            # relatif/absolu → pas un package npm
      node:*) continue ;;           # builtin explicite
    esac
    # Nom de package racine : @scope/name ou name (drop sous-chemins)
    case "$spec" in
      @*/*) root="$(printf '%s' "$spec" | cut -d/ -f1-2)" ;;
      *)    root="$(printf '%s' "$spec" | cut -d/ -f1)" ;;
    esac
    # Builtin Node sans préfixe ?
    case " $NODE_BUILTINS " in *" $root "*) continue ;; esac
    # Transitif sûr fourni par un package déclaré (ex: express via platform-express) ?
    case " $KNOWN_TRANSITIVE " in *" $root "*) continue ;; esac
    # Path alias internes (tsconfig paths) — aucun dans api/ aujourd'hui,
    # mais on tolère les specifiers qui matchent un répertoire src connu.
    # Déclaré dans package.json ?
    if printf '%s\n' "$DECLARED" | grep -qxF "$root"; then
      continue
    fi
    missing="$missing\n  $root  (importé dans $f)"
  done
done

if [ -n "$missing" ]; then
  echo "${RED}✗ Import(s) non résolu(s) dans api/ (absents de api/package.json) :${NC}"
  printf "%b\n" "$missing" | sort -u
  echo ""
  echo "  → Ajoute la dépendance à api/package.json ET regénère api/package-lock.json,"
  echo "    sinon la CI casse au 'npm ci' propre (Cannot find module)."
  exit 1
fi
echo "${GREEN}  ✓ imports api/ résolvent tous dans package.json${NC}"

# ─── Check 2 : tsc --noEmit incrémental (si node_modules déjà présent) ───────
if [ -d "api/node_modules" ]; then
  echo "  typecheck api/ (tsc --noEmit, incrémental)…"
  ( cd api && npx --no-install tsc -p tsconfig.build.json --noEmit )
  echo "${GREEN}  ✓ typecheck api/ OK${NC}"
else
  echo "${YELLOW}  ⚠ api/node_modules absent → typecheck complet délégué à la CI"
  echo "    (on n'installe pas les deps en pre-push pour préserver la RAM).${NC}"
fi

echo "${GREEN}─── engine api : OK ───${NC}"
