#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
prod_hcl="$root/deploy/analytics-engine.nomad.hcl"
staging_hcl="$root/deploy/analytics-engine-staging.nomad.hcl"
prod_ci="$root/.github/workflows/prod-ci.yml"
staging_ci="$root/.github/workflows/staging-deploy.yml"
onprem_gate="$root/.github/workflows/e2e-gate-onpremise.yml"
structural="$root/scripts/ci/check-structural-changes.sh"

fail(){ echo "ERREUR: $*" >&2; exit 1; }
require_fixed(){ grep -Fq -- "$2" "$1" || fail "$3"; }
reject_fixed(){ ! grep -Fq -- "$2" "$1" || fail "$3"; }
require_count(){
  local file=$1 pattern=$2 minimum=$3 label=$4 count
  count=$(grep -Fc -- "$pattern" "$file" || true)
  [ "$count" -ge "$minimum" ] || fail "$label ($count < $minimum)"
}

require_fixed "$prod_hcl" 'priority    = 80' 'priorité prod 80 absente'
require_fixed "$prod_hcl" 'value     = "ovh-prod"' 'placement prod ovh-prod absent'
require_fixed "$prod_hcl" 'auto_revert       = true' 'auto-revert prod absent'
require_fixed "$prod_hcl" 'progress_deadline = "10m"' 'deadline prod bornée absente'

require_count "$prod_hcl" 'memory_max = 7000' 4 "plafonds mémoire prod incomplets dans $(basename "$prod_hcl")"
require_count "$staging_hcl" 'memory_max =' 4 "fusibles mémoire staging incomplets dans $(basename "$staging_hcl")"
reject_fixed "$staging_hcl" 'memory_max = 7000' 'fusible mémoire staging dangereux encore présent'

for hcl in "$prod_hcl" "$staging_hcl"; do
  require_count "$hcl" 'init  = true' 2 "init Docker app+bridge absent dans $(basename "$hcl")"
  require_count "$hcl" 'check_restart {' 2 "self-heal app+bridge incomplet dans $(basename "$hcl")"
  require_count "$hcl" 'path     = "/api/health"' 2 "checks engine non alignés sur le probe stable dans $(basename "$hcl")"
  reject_fixed "$hcl" '/api/setup.status' "ancien probe throttlé encore utilisé dans $(basename "$hcl")"
  require_count "$hcl" 'shutdown_delay = "10s"' 2 "shutdown propre app+bridge incomplet dans $(basename "$hcl")"
done

require_fixed "$prod_ci" 'veridian-node-backup.sh' 'backup ClickHouse cross-nœud prod absent'
require_fixed "$prod_ci" 'prod-r2-backup.sh' 'backup PostgreSQL R2 prod absent'
require_fixed "$prod_ci" 'pré-pull prod impossible après 3 tentatives' 'retry pré-pull prod absent'
require_fixed "$staging_ci" 'pré-pull staging impossible après 3 tentatives' 'retry pré-pull staging absent'
require_fixed "$prod_ci" 'RUN_INDEX_ARGS=(-check-index "$MODIFY_INDEX")' 'check-index prod absent'
require_fixed "$staging_ci" 'RUN_INDEX_ARGS=(-check-index "$MODIFY_INDEX")' 'check-index staging absent'
require_fixed "$prod_ci" 'nomad job plan a échoué' 'plan prod non fail-closed'
require_fixed "$staging_ci" 'nomad job plan a échoué' 'plan staging non fail-closed'
require_fixed "$staging_ci" 'check-clickhouse-log-retention.py' 'contrat rétention ClickHouse staging absent de la CI'
reject_fixed "$prod_ci" 'nomad job plan -var "image_tag=${IMAGE_TAG}" "$REMOTE_HCL" || true' 'erreur de plan prod masquée'
reject_fixed "$staging_ci" 'nomad job plan -var "image_tag=${IMAGE_TAG}" "$REMOTE_HCL" || true' 'erreur de plan staging masquée'
require_fixed "$structural" "'^deploy/.*\\.nomad\\.hcl$'" 'HCL Nomad absent du structural gate'
require_fixed "$onprem_gate" '- "deploy/*.nomad.hcl"' 'HCL Nomad absent du trigger E2E on-premise'
require_fixed "$onprem_gate" '- ".github/workflows/staging-deploy.yml"' 'workflow staging absent du trigger E2E on-premise'
require_fixed "$onprem_gate" '- ".github/workflows/prod-ci.yml"' 'workflow prod absent du trigger E2E on-premise'

echo 'OK: invariants GitOps Nomad Analytics'
