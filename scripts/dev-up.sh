#!/usr/bin/env bash
# ============================================================================
# scripts/dev-up.sh — Bootstrap env DEV hot-reload sur dev-pub
# ============================================================================
#
# À exécuter SUR dev-pub (pas en local). Depuis ta machine :
#   ssh dev-pub 'bash /opt/dev/analytics-engine/scripts/dev-up.sh'
#
# Ce script :
#   1. Sync le repo (branche `dev`) dans /opt/dev/analytics-engine
#   2. Écrit .env.dev si manquant (sinon le préserve)
#   3. (Re)build + lance le compose dev
#   4. Affiche les URLs Tailscale et l'état
#
# Idempotent : tu peux le relancer autant de fois que tu veux.
# Pour stopper proprement : scripts/dev-down.sh.
#
# Variables d'env attendues (export avant de lancer, OU stockées dans
# /opt/dev/analytics-engine/.env.dev) :
#   CLICKHOUSE_PASSWORD       (par défaut "devpass" si absent)
#   ENCRYPTION_KEY            (par défaut auto-généré via openssl la 1re fois)
#   STAMINADS_ADMIN_EMAIL     (par défaut admin@veridian.site)
#   STAMINADS_ADMIN_PASSWORD  (par défaut auto-généré si absent)
#   VERIDIAN_ADMIN_API_KEY    (par défaut auto-généré si absent)
# ============================================================================

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/dev/analytics-engine}"
REPO_URL="${REPO_URL:-https://github.com/Christ-Roy/veridian-analytics-engine.git}"
BRANCH="${BRANCH:-dev}"
ENV_FILE="${REPO_DIR}/.env.dev"

echo "═══════════════════════════════════════════════════════════════"
echo " Veridian Analytics Engine — DEV bootstrap"
echo " Repo dir  : ${REPO_DIR}"
echo " Branch    : ${BRANCH}"
echo "═══════════════════════════════════════════════════════════════"

# ─── 1. Sync repo ──────────────────────────────────────────────────────────
if [ ! -d "${REPO_DIR}/.git" ]; then
    echo "[1/4] Clone initial du repo..."
    sudo mkdir -p "$(dirname "${REPO_DIR}")"
    sudo chown "$(whoami):$(whoami)" "$(dirname "${REPO_DIR}")"
    git clone --branch "${BRANCH}" "${REPO_URL}" "${REPO_DIR}"
else
    echo "[1/4] Pull dernière révision branche '${BRANCH}'..."
    cd "${REPO_DIR}"
    git fetch origin
    git checkout "${BRANCH}"
    git reset --hard "origin/${BRANCH}"
fi

cd "${REPO_DIR}"

# ─── 2. Écriture .env.dev (préserve si existe déjà) ───────────────────────
if [ ! -f "${ENV_FILE}" ]; then
    echo "[2/4] Génération .env.dev initiale..."
    CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-$(openssl rand -hex 16)}"
    ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
    STAMINADS_ADMIN_EMAIL="${STAMINADS_ADMIN_EMAIL:-admin@veridian.site}"
    STAMINADS_ADMIN_PASSWORD="${STAMINADS_ADMIN_PASSWORD:-$(openssl rand -hex 16)}"
    VERIDIAN_ADMIN_API_KEY="${VERIDIAN_ADMIN_API_KEY:-$(openssl rand -hex 32)}"

    cat > "${ENV_FILE}" <<EOF
# Généré automatiquement par scripts/dev-up.sh
# Ne pas commiter (cf .gitignore).
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
STAMINADS_ADMIN_EMAIL=${STAMINADS_ADMIN_EMAIL}
STAMINADS_ADMIN_PASSWORD=${STAMINADS_ADMIN_PASSWORD}
VERIDIAN_ADMIN_API_KEY=${VERIDIAN_ADMIN_API_KEY}
APP_URL=https://dev-server-1.tail324436.ts.net
CORS_ALLOWED_ORIGINS=https://dev-server-1.tail324436.ts.net,http://localhost:3000,http://localhost:5173
PUBLIC_STAMINADS_URL=https://dev-server-1.tail324436.ts.net
EOF
    chmod 600 "${ENV_FILE}"
    echo "    → .env.dev généré : ${ENV_FILE}"
    echo "    → admin staminads : ${STAMINADS_ADMIN_EMAIL} / ${STAMINADS_ADMIN_PASSWORD}"
else
    echo "[2/4] .env.dev existant, préservé."
fi

# ─── 3. Build + démarrage du compose ──────────────────────────────────────
# NB : on PASSE -p analytics-engine-dev explicitement en plus du `name:` dans
# le yml (ceinture + bretelles) pour garantir l'isolation vs staging.
# ⚠️ Surtout pas `--remove-orphans` global : on cible le project dev seul.
echo "[3/4] Build + démarrage stack dev (peut prendre 2-5 min au 1er run)..."
docker compose --env-file "${ENV_FILE}" -p analytics-engine-dev \
    -f compose/dev.yml up -d --build

# ─── 4. Smoke + URLs ──────────────────────────────────────────────────────
echo "[4/4] Attente services healthy..."
for i in $(seq 1 60); do
    ENGINE=$(docker inspect --format='{{.State.Health.Status}}' analytics-engine-dev 2>/dev/null || echo "starting")
    BRIDGE=$(docker inspect --format='{{.State.Health.Status}}' analytics-engine-dev-bridge 2>/dev/null || echo "starting")
    if [ "${ENGINE}" = "healthy" ] && [ "${BRIDGE}" = "healthy" ]; then
        echo "    → engine + bridge healthy après ${i}×5s"
        break
    fi
    echo "    [${i}/60] engine=${ENGINE} bridge=${BRIDGE}..."
    sleep 5
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✓ Stack dev démarrée"
echo "═══════════════════════════════════════════════════════════════"
echo " Engine (NestJS)  : http://127.0.0.1:3000/api/setup.status"
echo " Bridge Veridian  : http://127.0.0.1:3002/health"
echo " ClickHouse       : http://127.0.0.1:8123/ping"
echo ""
echo " Pour exposer via Tailscale HTTPS (depuis ta machine locale) :"
echo "   ssh dev-pub 'bash /opt/dev/analytics-engine/scripts/dev-expose.sh'"
echo ""
echo " Pour suivre les logs en live :"
echo "   ssh dev-pub 'docker logs -f analytics-engine-dev'"
echo "═══════════════════════════════════════════════════════════════"
