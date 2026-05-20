#!/usr/bin/env bash
# DEPRECATED 2026-05-20 : on n'utilise plus `tailscale serve`.
# La stack dev est désormais exposée via Traefik staging-edge sur :
#   - https://analytics-engine-dev.staging.veridian.site/
#   - https://analytics-engine-bridge-dev.staging.veridian.site/
#
# Joignable uniquement depuis le tailnet (wildcard *.staging.veridian.site →
# IP dev-pub privée derrière Tailscale).
#
# Pour fermer une vieille config tailscale serve résiduelle :
#   ssh dev-pub 'sudo tailscale serve reset'

set -euo pipefail
echo "⚠️  Ce script est DEPRECATED depuis 2026-05-20."
echo "    L'env dev passe désormais par Traefik staging-edge."
echo ""
echo "    URLs :"
echo "      https://analytics-engine-dev.staging.veridian.site/"
echo "      https://analytics-engine-bridge-dev.staging.veridian.site/health"
echo ""
echo "    Si une vieille config tailscale serve traîne :"
echo "      sudo tailscale serve reset"
exit 0
