#!/usr/bin/env bash
# ============================================================================
# scripts/dev-expose.sh — Expose la stack dev via Tailscale serve (HTTPS)
# ============================================================================
#
# Tailscale serve : reverse proxy HTTPS interne au tailnet (pas Internet public).
# Cert Let's Encrypt auto via MagicDNS. Aucune config DNS Cloudflare nécessaire.
#
# Routes mappées sur dev-server-1.tail324436.ts.net :
#   /          → engine (console + API NestJS, port 3000)
#   /bridge/   → bridge Veridian (port 3002) — strip prefix
#
# Pour killer l'exposition :
#   tailscale serve reset
#
# Pré-requis : tailscaled fonctionne sur dev-pub (status checked en bootstrap).
# ============================================================================

set -euo pipefail

echo "═══════════════════════════════════════════════════════════════"
echo " Tailscale serve — Veridian Analytics Engine (DEV)"
echo "═══════════════════════════════════════════════════════════════"

# Reset propre avant de reconfigurer (idempotent)
sudo tailscale serve reset 2>/dev/null || true

# Engine : tout le trafic root → NestJS (qui sert API + console statique)
sudo tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:3000

# Bridge Veridian : sous-chemin /bridge → port 3002
# NB : le bridge écoute sur / pour /health, /api/admin/*, etc.
# On lui colle un sous-chemin tailscale qui le proxy direct.
sudo tailscale serve --bg --https=443 --set-path=/bridge http://127.0.0.1:3002

echo ""
echo " ✓ Routes Tailscale serve actives :"
sudo tailscale serve status
echo ""
echo " URLs accessibles depuis ta machine locale (via Tailscale) :"
echo "   Engine + console :  https://dev-server-1.tail324436.ts.net/"
echo "   Engine API setup :  https://dev-server-1.tail324436.ts.net/api/setup.status"
echo "   Bridge health    :  https://dev-server-1.tail324436.ts.net/bridge/health"
echo ""
echo " Pour killer l'exposition :"
echo "   ssh dev-pub 'sudo tailscale serve reset'"
echo "═══════════════════════════════════════════════════════════════"
