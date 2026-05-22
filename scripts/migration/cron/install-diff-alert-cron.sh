#!/usr/bin/env bash
# ============================================================================
# install-diff-alert-cron.sh — installe le cron d'alerte dual-tracking (D2).
#
# À lancer SUR dev-pub (ssh dev-pub) avec un user sudo-capable, PENDANT les
# 30 jours d'observation post-migration. Il :
#   1. Copie migration-diff-alert.ts + lib/ dans /opt/veridian/analytics-migration
#   2. Installe les units systemd (service + timer quotidien 08:00 UTC)
#   3. Écrit /etc/veridian/migration-diff-alert.env (à compléter)
#   4. Active le timer
#
# Idempotent — réexécutable sans risque.
#
# DÉSINSTALLATION (après le cutover J+30) :
#   sudo systemctl disable --now migration-diff-alert.timer
#   sudo rm /etc/systemd/system/migration-diff-alert.{service,timer}
#   sudo systemctl daemon-reload
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_DIR="/opt/veridian/analytics-migration"
ENV_FILE="/etc/veridian/migration-diff-alert.env"

echo "[install] Copie des scripts dans ${INSTALL_DIR}"
sudo mkdir -p "${INSTALL_DIR}/lib"
sudo cp "${MIGRATION_DIR}/migration-diff-alert.ts" "${INSTALL_DIR}/"
sudo cp "${MIGRATION_DIR}"/lib/*.ts "${INSTALL_DIR}/lib/"

echo "[install] Installation des units systemd"
sudo cp "${SCRIPT_DIR}/migration-diff-alert.service" \
  /etc/systemd/system/migration-diff-alert.service
sudo cp "${SCRIPT_DIR}/migration-diff-alert.timer" \
  /etc/systemd/system/migration-diff-alert.timer

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[install] Écriture du template ${ENV_FILE} — À COMPLÉTER"
  sudo mkdir -p "$(dirname "${ENV_FILE}")"
  sudo tee "${ENV_FILE}" >/dev/null <<'ENV'
# Config alerte dual-tracking (migration D2).
# MIGRATION_DIFF_FILE : JSON des séries de diff (produit par le job de collecte).
MIGRATION_DIFF_FILE=/opt/veridian/analytics-migration/data/migration-diff.json
# Telegram — source : ~/credentials/.all-creds.env
TELEGRAM_BOT_TOKEN=CHANGE_ME
TELEGRAM_CHAT_ID=CHANGE_ME
ENV
  sudo chmod 600 "${ENV_FILE}"
else
  echo "[install] ${ENV_FILE} existe déjà — laissé tel quel"
fi

echo "[install] Activation du timer"
sudo systemctl daemon-reload
sudo systemctl enable --now migration-diff-alert.timer

echo "[install] Terminé. Prochain run :"
systemctl list-timers migration-diff-alert.timer --no-pager || true
echo
echo "  Test manuel :   sudo systemctl start migration-diff-alert.service"
echo "  Logs :          journalctl -u migration-diff-alert -f"
