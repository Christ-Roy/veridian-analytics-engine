#!/usr/bin/env bash
# check-integration-coverage.sh — Veridian Analytics Engine
#
# GATE "couverture d'intégration RÉELLE".
#
# Le problème : check-test-mapping.sh exige qu'un fichier source critique ait
# UN test. Mais un test contre FakePrismaClient suffit pour le satisfaire.
# Tests verts ≠ code correct (cf. T-INTEGRATION-TESTS.md : 29/34 fichiers
# tournaient contre des mocks in-memory).
#
# Ce gate ajoute un niveau : pour chaque fichier CRITIQUE modifié, exige qu'il
# existe au moins un test `*.integration.test.ts` qui le couvre — un test qui
# tape un vrai Postgres / une vraie staminads, pas un fake déguisé.
#
# Mapping : section `integration_covered_by:` du test-coverage-map.yaml.
#
# ─── Fichiers critiques (chemins du fork — sous veridian-bridge/src/) ───────
#   veridian-bridge/src/forms/*       — ingest leads, dedup, rate-limit, XSS
#   veridian-bridge/src/push/*        — subscribe/send/cleanup 410
#   veridian-bridge/src/hub/*         — provision, attach-owner, health, store
#   veridian-bridge/src/gsc/*         — oauth, sync, query, routes
#   veridian-bridge/src/hub-hmac.ts   — vérif HMAC (replay, tamper)
#   veridian-bridge/src/paywall.ts    — gating paywall
#   veridian-bridge/src/score.ts      — score Veridian global
#   veridian-bridge/src/tenant-status.ts — agrégation statut tenant
#
# ─── Modes ─────────────────────────────────────────────────────────────────
#   MODE=warn   (DÉFAUT actuel) : un fichier critique sans test d'intégration
#               → WARNING jaune, n'arrête pas le push. Pendant que T1-T5
#               écrivent leurs tests, on ne bloque pas le travail des agents.
#   MODE=block  : un fichier critique sans test d'intégration → BLOQUE le push.
#               À activer quand T2-T5 ont fini (cf. §"PASSAGE WARN→BLOCK").
#
#   Override : INTEGRATION_GATE=block ./scripts/ci/check-integration-coverage.sh
#   ou éditer la constante MODE ci-dessous.
#
# ─── Allowlist transitoire ─────────────────────────────────────────────────
#   Les fichiers listés dans la section `# ALLOWLIST` ci-dessous sont tolérés
#   SANS test d'intégration même en MODE=block — le temps que l'agent T*
#   correspondant écrive la suite. Chaque entrée DOIT porter un commentaire
#   `# TODO: intégration <agent>`. On vide cette liste au fur et à mesure.
#
# ─── PASSAGE WARN→BLOCK ────────────────────────────────────────────────────
#   1. T2-T5 ont mergé leurs `*.integration.test.ts` sur staging
#   2. test-coverage-map.yaml a une section `integration_covered_by:` pour
#      chaque groupe de fichiers critiques
#   3. L'allowlist ci-dessous est vide
#   4. Passer MODE="block" + retirer ce paragraphe
#
# Usage :
#   ./scripts/ci/check-integration-coverage.sh                  # pre-push
#   BASE_REF=origin/staging ./scripts/ci/check-integration-coverage.sh  # CI
#   BASE_REF=HEAD ./scripts/ci/check-integration-coverage.sh    # working tree
#   INTEGRATION_GATE=block ./scripts/ci/check-integration-coverage.sh   # force

set -euo pipefail

# ─── Mode (warn|block) — éditer ici pour le bascule définitive ──────────────
MODE="${INTEGRATION_GATE:-warn}"

# ─── Allowlist transitoire ──────────────────────────────────────────────────
# Fichiers critiques tolérés SANS test d'intégration (même en MODE=block).
# Format : un chemin par ligne. Vider au fur et à mesure que T2-T5 livrent.
ALLOWLIST=$(cat <<'EOF'
# ── Hub (T2) — provision/attach-owner/health/store/hmac/paywall ──
veridian-bridge/src/hub/provision.ts        # TODO: intégration T2
veridian-bridge/src/hub/attach-owner.ts     # TODO: intégration T2
veridian-bridge/src/hub/health.ts           # TODO: intégration T2
veridian-bridge/src/hub/store.ts            # TODO: intégration T2
veridian-bridge/src/hub-hmac.ts             # TODO: intégration T2
veridian-bridge/src/paywall.ts              # TODO: intégration T2
# ── Forms (T3) — ingest/dedup/rate-limit/xss/query ──
veridian-bridge/src/forms/index.ts          # TODO: intégration T3
veridian-bridge/src/forms/ingest.ts         # TODO: intégration T3
veridian-bridge/src/forms/query.ts          # TODO: intégration T3
veridian-bridge/src/forms/routes.ts         # TODO: intégration T3
veridian-bridge/src/forms/sanitize.ts       # TODO: intégration T3
veridian-bridge/src/forms/rate-limit.ts     # TODO: intégration T3
veridian-bridge/src/forms/staminads-event.ts # TODO: intégration T3
veridian-bridge/src/forms/types.ts          # TODO: intégration T3
# ── GSC (T4) — oauth/sync/query/routes ──
veridian-bridge/src/gsc/index.ts            # TODO: intégration T4
veridian-bridge/src/gsc/oauth.ts            # TODO: intégration T4
veridian-bridge/src/gsc/sync.ts             # TODO: intégration T4
veridian-bridge/src/gsc/query.ts            # TODO: intégration T4
veridian-bridge/src/gsc/routes.ts           # TODO: intégration T4
# ── Push + Score/tenant-status (T5) ──
veridian-bridge/src/push/index.ts           # TODO: intégration T5
veridian-bridge/src/push/routes.ts          # TODO: intégration T5
veridian-bridge/src/score.ts                # TODO: intégration T5
veridian-bridge/src/tenant-status.ts        # TODO: intégration T5
EOF
)

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

COVERAGE_MAP="test-coverage-map.yaml"

# ─── Liste des fichiers critiques (globs) ───────────────────────────────────
# Un fichier matché par un de ces patterns est CRITIQUE.
is_critical() {
  local f="$1"
  case "$f" in
    veridian-bridge/src/forms/*.ts) return 0 ;;
    veridian-bridge/src/push/*.ts)  return 0 ;;
    veridian-bridge/src/hub/*.ts)   return 0 ;;
    veridian-bridge/src/gsc/*.ts)   return 0 ;;
    veridian-bridge/src/hub-hmac.ts)      return 0 ;;
    veridian-bridge/src/paywall.ts)       return 0 ;;
    veridian-bridge/src/score.ts)         return 0 ;;
    veridian-bridge/src/tenant-status.ts) return 0 ;;
    *) return 1 ;;
  esac
}

# ─── Allowlist lookup ───────────────────────────────────────────────────────
# Strip les commentaires inline (` # ...`) pour matcher le chemin nu.
is_allowlisted() {
  local f="$1"
  echo "$ALLOWLIST" | sed -E 's/[[:space:]]*#.*$//' | grep -vE '^[[:space:]]*$' | grep -Fxq "$f"
}

# ─── Diff resolution ────────────────────────────────────────────────────────
# Une base fournie EXPLICITEMENT n'est jamais remplacée en douce : si elle est
# fausse, on le dit. Seule la base DÉDUITE (origin/<branche>, qui n'existe pas
# tant que la branche n'a pas été poussée) peut retomber sur le tronc.
BASE_REF_EXPLICIT="${BASE_REF:-}"
BASE_REF="${BASE_REF:-origin/$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo staging)}"
if [ "$BASE_REF" = "HEAD" ]; then
  CHANGED=$( (git diff --name-only HEAD; git diff --cached --name-only) | sort -u | grep -v '^$' || true)
else
  if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    if [ -n "$BASE_REF_EXPLICIT" ]; then
      echo "${RED}✗ integration-coverage : BASE_REF='$BASE_REF' fourni mais introuvable.${NC}" >&2
      echo "  Refus de lui substituer une autre base sans le dire." >&2
      exit 1
    fi
    BASE_REF="origin/staging"
  fi
  # Anciennement : skip silencieux « premier push ? ». C'est exactement le
  # motif qui a laissé ce gate inopérant pendant une semaine (origin/staging
  # supprimée le 2026-08-11, constaté le 2026-08-18). Un gate qui se
  # désactive tout seul n'est pas un gate.
  if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    echo "${RED}✗ integration-coverage : base '$BASE_REF' introuvable.${NC}" >&2
    echo "  Refus de sauter le contrôle (git fetch origin ?)." >&2
    echo "  Base explicite : BASE_REF=origin/main $0" >&2
    exit 1
  fi
  CHANGED=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || true)
fi

if [ -z "$CHANGED" ]; then
  echo "${GREEN}✓ Integration-coverage : aucun fichier modifié${NC}"
  exit 0
fi

echo "${BLUE}─── Integration-coverage gate (mode: $MODE, vs $BASE_REF) ───${NC}"

# ─── Extraction d'un bloc integration_covered_by pour un fichier ────────────
# Lit la section `integration_covered_by:` du bloc YAML dont les `sources:`
# contiennent le fichier cible.
integration_tests_for() {
  local target="$1"
  [ -f "$COVERAGE_MAP" ] || return 0
  awk -v target="$target" '
    # Début d un nouveau bloc YAML (- sources:)
    /^- sources:/        { in_block=1; has_target=0; in_int=0; next }
    # Ligne source à l intérieur d un bloc
    in_block && /^    - / && !in_int {
      src=$0; sub(/^    - /,"",src); gsub(/[[:space:]]+$/,"",src)
      if (src == target) has_target=1
      next
    }
    # Section integration_covered_by
    in_block && /^  integration_covered_by:/ { in_int=1; next }
    # Lignes de la section integration
    in_int && /^    - / {
      if (has_target) { t=$0; sub(/^    - /,"",t); gsub(/[[:space:]]+$/,"",t); print t }
      next
    }
    # Sortie de section integration (autre clé de même indent)
    in_int && /^  [a-z_]+:/ { in_int=0 }
    # Fin de bloc
    /^$/ { in_block=0; in_int=0; has_target=0 }
  ' "$COVERAGE_MAP"
}

MISSING=0
WARNED=0
OK=0

for file in $CHANGED; do
  is_critical "$file" || continue

  # Le fichier doit exister (pas une suppression)
  [ -f "$file" ] || continue

  # Cherche les tests d intégration déclarés
  INT_TESTS=$(integration_tests_for "$file" || true)
  HIT=0
  if [ -n "$INT_TESTS" ]; then
    while IFS= read -r t; do
      [ -z "$t" ] && continue
      if [ -f "$t" ]; then
        HIT=1
        break
      fi
    done <<< "$INT_TESTS"
  fi

  if [ "$HIT" = "1" ]; then
    echo "${GREEN}✓${NC} $file → couvert par test(s) d'intégration"
    OK=$((OK + 1))
    continue
  fi

  # Pas de test d intégration. Allowlisté ?
  if is_allowlisted "$file"; then
    echo "${YELLOW}⊘${NC} $file — allowlist transitoire (test d'intégration à écrire par T*)"
    WARNED=$((WARNED + 1))
    continue
  fi

  # Pas couvert et pas allowlisté
  if [ "$MODE" = "block" ]; then
    echo "${RED}✗${NC} $file modifié SANS test d'intégration *.integration.test.ts"
    echo "    Un fichier critique doit être testé contre un VRAI service (Postgres/staminads),"
    echo "    pas seulement contre un FakePrismaClient."
    echo "    Solutions :"
    echo "      1. Écrire un test veridian-bridge/tests/integration/<x>.integration.test.ts"
    echo "      2. Le déclarer dans $COVERAGE_MAP (section integration_covered_by:)"
    echo "      3. Ajouter le fichier à l'ALLOWLIST de ce script (dette transitoire, avec TODO)"
    MISSING=$((MISSING + 1))
  else
    echo "${YELLOW}⚠${NC} $file modifié sans test d'intégration (mode warn — non bloquant)"
    echo "    À couvrir : veridian-bridge/tests/integration/<x>.integration.test.ts"
    WARNED=$((WARNED + 1))
  fi
done

echo
if [ "$MISSING" -gt 0 ]; then
  echo "${RED}╔═══════════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ INTEGRATION-COVERAGE REFUSÉ — $MISSING fichier(s) critique(s) nu(s) ║${NC}"
  echo "${RED}╚═══════════════════════════════════════════════════════════════╝${NC}"
  echo "Constitution CI §3 : pas de --no-verify."
  exit 1
fi

if [ "$WARNED" -gt 0 ]; then
  echo "${YELLOW}⚠ $WARNED fichier(s) critique(s) sans test d'intégration (toléré : mode=$MODE/allowlist).${NC}"
  echo "${YELLOW}  Quand T2-T5 ont livré : vider l'ALLOWLIST + passer MODE=\"block\".${NC}"
fi

echo "${GREEN}✓ Integration-coverage : $OK couvert(s), $WARNED toléré(s), 0 bloquant${NC}"
exit 0
