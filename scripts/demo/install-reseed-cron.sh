#!/usr/bin/env bash
# ============================================================================
# install-reseed-cron.sh — Install the demo re-seed systemd timer on dev-pub.
#
# Run this ON dev-pub (ssh dev-pub) as a sudo-capable user. It:
#   1. Copies reseed-demo.sh to /opt/veridian/analytics-demo/
#   2. Installs the systemd service + timer units
#   3. Writes /etc/veridian/demo-reseed.env (you must fill DEMO_SECRET)
#   4. Enables + starts the timer
#
# Idempotent — safe to re-run.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/veridian/analytics-demo"
ENV_FILE="/etc/veridian/demo-reseed.env"

echo "[install] Creating ${INSTALL_DIR}"
sudo mkdir -p "${INSTALL_DIR}"
sudo cp "${SCRIPT_DIR}/reseed-demo.sh" "${INSTALL_DIR}/reseed-demo.sh"
sudo chmod 755 "${INSTALL_DIR}/reseed-demo.sh"

echo "[install] Installing systemd units"
sudo cp "${SCRIPT_DIR}/reseed-demo.service" /etc/systemd/system/reseed-demo.service
sudo cp "${SCRIPT_DIR}/reseed-demo.timer" /etc/systemd/system/reseed-demo.timer

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[install] Writing ${ENV_FILE} template — EDIT IT to set DEMO_SECRET"
  sudo mkdir -p "$(dirname "${ENV_FILE}")"
  sudo tee "${ENV_FILE}" >/dev/null <<'ENV'
# Veridian Analytics demo re-seed config.
DEMO_URL=https://demo-analytics.veridian.site
# DEMO_SECRET = value of DEMO_SECRET_ANALYTICS in ~/credentials/.all-creds.env
DEMO_SECRET=CHANGE_ME
# Optional Telegram alerting on failure:
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
ENV
  sudo chmod 600 "${ENV_FILE}"
else
  echo "[install] ${ENV_FILE} already exists — leaving it untouched"
fi

echo "[install] Enabling timer"
sudo systemctl daemon-reload
sudo systemctl enable --now reseed-demo.timer

echo "[install] Done. Next run:"
systemctl list-timers reseed-demo.timer --no-pager || true
echo
echo "  Trigger a manual re-seed now:  sudo systemctl start reseed-demo.service"
echo "  Watch the result:              journalctl -u reseed-demo -f"
