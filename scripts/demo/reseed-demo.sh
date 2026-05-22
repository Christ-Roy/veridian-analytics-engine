#!/usr/bin/env bash
# ============================================================================
# reseed-demo.sh — Nightly re-seed of the public Veridian Analytics demo.
#
# Why: the demo workspace shows 90 days of data ending "today". Without a
# nightly re-seed the date axis drifts and the dashboard looks stale.
#
# What it does:
#   1. Smoke check — GET /api/health must be 200, else abort + alert.
#   2. POST /api/demo.delete?secret=...  (drops the demo workspace + data)
#   3. POST /api/demo.generate?secret=... (regenerates 200k sessions / 90d)
#
# Runtime ~5-10 min (200k sessions). Meant to run at 03:00 UTC via the
# systemd timer reseed-demo.timer (see this directory).
#
# Required env (systemd EnvironmentFile, e.g. /etc/veridian/demo-reseed.env):
#   DEMO_URL     = https://demo-analytics.veridian.site
#   DEMO_SECRET  = the DEMO_SECRET value (DEMO_SECRET_ANALYTICS in all-creds)
# Optional:
#   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — if set, failures alert Telegram.
# ============================================================================
set -euo pipefail

DEMO_URL="${DEMO_URL:?DEMO_URL is required}"
DEMO_SECRET="${DEMO_SECRET:?DEMO_SECRET is required}"

log() { echo "[reseed-demo] $(date -u +%FT%TZ) $*"; }

alert() {
  local msg="$1"
  log "ALERT: ${msg}"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -fsS -X POST \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d text="🔴 Veridian Analytics demo re-seed: ${msg}" >/dev/null || true
  fi
}

# 1. Smoke check before touching anything.
log "Health check ${DEMO_URL}/api/health"
if ! curl -fsS --max-time 15 "${DEMO_URL}/api/health" >/dev/null; then
  alert "health check failed — demo instance is down, aborting re-seed"
  exit 1
fi

# 2. Delete existing demo data.
log "Deleting existing demo workspace"
if ! curl -fsS --max-time 120 -X POST \
  "${DEMO_URL}/api/demo.delete?secret=${DEMO_SECRET}" >/dev/null; then
  alert "demo.delete failed"
  exit 1
fi

# 3. Regenerate. Generous timeout — 200k sessions over 90 days.
log "Generating fresh demo data (this takes 5-10 min)"
RESULT=$(curl -fsS --max-time 1200 -X POST \
  "${DEMO_URL}/api/demo.generate?secret=${DEMO_SECRET}") || {
  alert "demo.generate failed"
  exit 1
}
log "Re-seed OK: ${RESULT}"

# 4. Post-seed sanity check.
if ! curl -fsS --max-time 15 "${DEMO_URL}/api/health" >/dev/null; then
  alert "post-seed health check failed"
  exit 1
fi
log "Done."
