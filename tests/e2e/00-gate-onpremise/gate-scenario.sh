#!/usr/bin/env bash
#
# gate-scenario.sh — LE rempart E2E on-premise, exécuté SUR dev-pub.
#
# Pourquoi ce script (et pas la spec Playwright `.spec.ts`) en CI ?
#   `analytics-engine.staging.veridian.site` résout sur une IP Tailnet
#   (100.64.0.0/10) — staging est derrière Tailscale par design. Un runner
#   GitHub public NE PEUT PAS l'atteindre (curl → 000). C'est la raison de fond
#   pour laquelle tous les E2E staging "publics" cancellaient/skippaient depuis
#   toujours : la cible était physiquement injoignable.
#   La voie propre, déjà éprouvée par staging-deploy.yml, est d'exécuter le
#   check DANS dev-pub (qui est sur le tailnet et atteint l'engine en local).
#   Le scénario gate étant 100% des appels HTTP M2M, un script bash autonome
#   est parfaitement lisible — pas besoin de Playwright (qui imposerait un build
#   local interdit sur dev-pub, 7.6Gi RAM).
#
# Ce que le gate prouve, contre le STAGING RÉEL (ClickHouse réel, API M2M
# native `/api/admin/platform/*`), sur le VRAI scope commercialisé :
#   1. Tracking : provision → snippet correct → ingestion round-trip ClickHouse
#      (tracking.verify dry-run + auto-purge) → /api/track public → query.
#   2. Calls / VoIP : voip.addPhoneNumber + voip.listPhoneNumbers (par source).
#   3. Search Console : gsc.status (connecteur câblé).
#
# SELF-CONTAINED + IDEMPOTENT : crée SON workspace jetable (e2e_gate_*),
# le purge en fin de run (trap EXIT → super-admin workspaces.delete). Zéro
# pollution des données client réelles.
#
# Variables d'env attendues (injectées par le workflow via SSH) :
#   PLATFORM_ADMIN_API_KEY   (obligatoire) — clé M2M staging
#   E2E_ADMIN_EMAIL/PASSWORD (optionnels)  — super-admin pour le cleanup
#   BASE                     (optionnel)   — défaut staging engine URL
#
# Sortie : exit 0 = gate VERT (promo prod autorisée), exit !=0 = gate ROUGE.

set -uo pipefail

BASE="${BASE:-https://analytics-engine.staging.veridian.site}"
KEY="${PLATFORM_ADMIN_API_KEY:-}"
RUN="$(date +%s)$RANDOM"
WS="e2e_gate_${RUN}"
FAILED=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

if [ -z "$KEY" ]; then
  red "PLATFORM_ADMIN_API_KEY manquant — le gate ne peut pas valider l'API M2M."
  exit 2
fi

# POST M2M : $1=action, $2=json body.
# Met le HTTP code dans la GLOBALE HTTP_CODE et le body dans HTTP_BODY.
# (On NE renvoie PAS via stdout : `X="$(m2m …)"` créerait un subshell où
#  l'assignation de HTTP_CODE serait perdue — bug classique. On utilise donc
#  des globales et les callers lisent $HTTP_BODY après l'appel.)
# Le code HTTP est suffixé après un marqueur unique (le body JSON contient des
# newlines → pas de \n comme séparateur fiable).
HTTP_MARK="<<<HTTPCODE>>>"
HTTP_CODE=""
HTTP_BODY=""
m2m() {
  local resp
  resp="$(curl -s -m 30 -w "${HTTP_MARK}%{http_code}" \
    -X POST "$BASE/api/admin/platform/$1" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $KEY" \
    -d "$2")"
  HTTP_CODE="${resp##*"$HTTP_MARK"}"
  HTTP_BODY="${resp%"$HTTP_MARK"*}"
}

# Assertion : $1=label, $2=condition-vraie?(0/1 via test), $3=détail
check() {
  if [ "$2" = "0" ]; then
    green "  ✓ $1"
  else
    red "  ✘ $1 — $3"
    FAILED=1
  fi
}

# ─── Cleanup garanti (trap) : supprime le workspace jetable ───────────────
cleanup() {
  local email="${E2E_ADMIN_EMAIL:-}" pass="${E2E_ADMIN_PASSWORD:-}"
  if [ -z "$email" ] || [ -z "$pass" ]; then
    echo "[cleanup] pas de super-admin creds — workspace $WS laissé (inerte, préfixe e2e_gate_)."
    return 0
  fi
  local token
  token="$(curl -s -m 20 -X POST "$BASE/api/auth.login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pass\"}" \
    | grep -oE '"access_token":"[^"]+"' | sed -E 's/.*"([^"]+)"/\1/')"
  if [ -z "$token" ]; then
    echo "[cleanup] login super-admin échoué — workspace $WS laissé."
    return 0
  fi
  local code
  code="$(curl -s -m 25 -o /dev/null -w '%{http_code}' \
    -X POST "$BASE/api/workspaces.delete" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $token" \
    -d "{\"id\":\"$WS\"}")"
  echo "[cleanup] workspace $WS delete → HTTP $code"
}
trap cleanup EXIT

echo "═══ E2E GATE on-premise (staging réel) — workspace jetable $WS ═══"

# ─── 1. Provision ─────────────────────────────────────────────────────────
echo "1. Provision tenant M2M (workspace + clé stam_live + snippet)"
m2m tenants.provision "{\"email\":\"e2e-gate-${RUN}@veridian-test.local\",\"siteUrl\":\"https://e2e-gate-${RUN}.example.com\",\"name\":\"E2E Gate ${RUN}\",\"workspace_id\":\"${WS}\",\"phoneNumbers\":[{\"e164\":\"+33199000000\",\"source\":\"seo\"}]}"
PROV="$HTTP_BODY"
check "provision HTTP 200/201" "$([ "$HTTP_CODE" = 200 ] || [ "$HTTP_CODE" = 201 ] && echo 0 || echo 1)" "got $HTTP_CODE: ${PROV:0:200}"
echo "$PROV" | grep -q "\"workspace_id\":\"$WS\"" && check "workspace_id correct" 0 || check "workspace_id correct" 1 "absent"
echo "$PROV" | grep -q '"api_key":"stam_live_' && check "api_key stam_live_*" 0 || check "api_key stam_live_*" 1 "absent"
echo "$PROV" | grep -q '/sdk/v1/tracker.js' && check "snippet → /sdk/v1/tracker.js" 0 || check "snippet → /sdk/v1/tracker.js" 1 "mauvais src"
echo "$PROV" | grep -q "data-workspace-id=\\\\\"$WS\\\\\"" && check "snippet data-workspace-id" 0 || check "snippet data-workspace-id" 1 "absent/mauvais"

# ─── 2. Status consolidé ──────────────────────────────────────────────────
echo "2. workspaces.status (existence + connecteurs câblés)"
m2m workspaces.status "{\"workspace_id\":\"$WS\"}"
ST="$HTTP_BODY"
check "status HTTP 200" "$([ "$HTTP_CODE" = 200 ] && echo 0 || echo 1)" "got $HTTP_CODE"
echo "$ST" | grep -q '"exists":true' && check "workspace exists:true" 0 || check "workspace exists:true" 1 "absent"
echo "$ST" | grep -q '"gsc"' && echo "$ST" | grep -q '"voip"' && echo "$ST" | grep -q '"webhooks"' \
  && check "blocs connecteurs présents (gsc/voip/webhooks)" 0 || check "blocs connecteurs présents" 1 "manquants"

# ─── 3. TRACKING — ingestion round-trip ClickHouse réelle (dry-run, purge) ─
echo "3. [TRACKING] tracking.verify — round-trip ClickHouse réel (zéro pollution)"
m2m tracking.verify "{\"workspace_id\":\"$WS\"}"
TV="$HTTP_BODY"
check "tracking.verify HTTP 200" "$([ "$HTTP_CODE" = 200 ] && echo 0 || echo 1)" "got $HTTP_CODE"
echo "$TV" | grep -q '"verdict":"ok"' && check "verdict=ok" 0 || check "verdict=ok" 1 "got: ${TV:0:200}"
echo "$TV" | grep -q '"ok":true' && check "ingestion.ok=true (event a traversé ClickHouse)" 0 || check "ingestion.ok=true" 1 "ingestion KO"

# ─── 4. TRACKING — /api/track public réel ─────────────────────────────────
echo "4. [TRACKING] /api/track public accepte un event réel"
NOW="$(date +%s)000"
TR="$(curl -s -m 20 -w "${HTTP_MARK}%{http_code}" -X POST "$BASE/api/track" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"$WS\",\"session_id\":\"e2e-gate-sess-${RUN}\",\"actions\":[{\"type\":\"pageview\",\"path\":\"/e2e-gate\",\"page_number\":1,\"duration\":1000,\"scroll\":50,\"entered_at\":$((NOW-1500)),\"exited_at\":$((NOW-500))}],\"attributes\":{\"landing_page\":\"/e2e-gate\"},\"visitor_id\":\"e2e-gate-vis-${RUN}\",\"created_at\":$((NOW-2000)),\"updated_at\":$NOW,\"sdk_version\":\"e2e-gate\"}")"
TR_CODE="${TR##*"$HTTP_MARK"}"
TR_BODY="${TR%"$HTTP_MARK"*}"
check "/api/track HTTP 200" "$([ "$TR_CODE" = 200 ] && echo 0 || echo 1)" "got $TR_CODE: ${TR_BODY:0:150}"
echo "$TR_BODY" | grep -q '"success":true' && check "track success:true" 0 || check "track success:true" 1 "got: ${TR_BODY:0:150}"

# ─── 5. TRACKING — analytics.query requêtable ─────────────────────────────
echo "5. [TRACKING] analytics.query répond une shape valide"
m2m analytics.query "{\"workspace_id\":\"$WS\",\"metrics\":[\"sessions\"],\"dateRange\":{\"preset\":\"previous_30_days\"}}"
AQ="$HTTP_BODY"
check "analytics.query HTTP 200" "$([ "$HTTP_CODE" = 200 ] && echo 0 || echo 1)" "got $HTTP_CODE"
echo "$AQ" | grep -q '"data"' && echo "$AQ" | grep -q '"sessions"' && check "query shape (data + metric sessions)" 0 || check "query shape" 1 "got: ${AQ:0:150}"

# ─── 6. CALLS / VoIP ──────────────────────────────────────────────────────
echo "6. [CALLS/VoIP] add + list phone number (par source)"
m2m voip.addPhoneNumber "{\"workspace_id\":\"$WS\",\"e164\":\"+33199887766\",\"source\":\"ads\"}"
VA="$HTTP_BODY"
check "voip.add HTTP 200" "$([ "$HTTP_CODE" = 200 ] && echo 0 || echo 1)" "got $HTTP_CODE"
echo "$VA" | grep -q '"ok":true' && check "voip.add ok:true" 0 || check "voip.add ok:true" 1 "got: ${VA:0:150}"
m2m voip.listPhoneNumbers "{\"workspace_id\":\"$WS\"}"
VL="$HTTP_BODY"
echo "$VL" | grep -q '+33199887766' && check "voip.list contient le numéro ajouté" 0 || check "voip.list contient le numéro" 1 "absent"

# ─── 7. SEARCH CONSOLE ────────────────────────────────────────────────────
echo "7. [SEARCH CONSOLE] gsc.status répond (connecteur câblé)"
m2m gsc.status "{\"workspace_id\":\"$WS\"}"
GS="$HTTP_BODY"
check "gsc.status HTTP 200" "$([ "$HTTP_CODE" = 200 ] && echo 0 || echo 1)" "got $HTTP_CODE"
echo "$GS" | grep -q '"connected":false' && check "gsc.connected=false (fraîchement provisionné)" 0 || check "gsc.connected lisible" 1 "got: ${GS:0:150}"

# ─── Verdict ──────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
if [ "$FAILED" = "0" ]; then
  green "GATE VERT — le vrai scope commercialisé fonctionne end-to-end sur staging réel."
  exit 0
else
  red "GATE ROUGE — une régression sur le parcours métier réel. NE PAS promote prod."
  exit 1
fi
