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

require_count "$prod_hcl" 'memory_max =' 4 "fusibles mémoire prod incomplets dans $(basename "$prod_hcl")"
require_count "$prod_hcl" 'memory_max = 512' 2 "fusibles mémoire prod 512 MiB incomplets"
require_fixed "$prod_hcl" 'memory_max = 1024' 'fusible mémoire engine prod incorrect'
require_fixed "$prod_hcl" 'memory_max = 3072' 'fusible mémoire ClickHouse prod incorrect'
reject_fixed "$prod_hcl" 'memory_max = 7000' 'fusible mémoire prod dangereux encore présent'
require_count "$staging_hcl" 'memory_max =' 4 "fusibles mémoire staging incomplets dans $(basename "$staging_hcl")"
reject_fixed "$staging_hcl" 'memory_max = 7000' 'fusible mémoire staging dangereux encore présent'

for hcl in "$prod_hcl" "$staging_hcl"; do
  require_count "$hcl" 'init  = true' 2 "init Docker app+bridge absent dans $(basename "$hcl")"
  require_count "$hcl" 'check_restart {' 2 "self-heal app+bridge incomplet dans $(basename "$hcl")"
  require_count "$hcl" 'path     = "/api/health"' 2 "checks engine non alignés sur le probe stable dans $(basename "$hcl")"
  reject_fixed "$hcl" '/api/setup.status' "ancien probe throttlé encore utilisé dans $(basename "$hcl")"
  require_count "$hcl" 'shutdown_delay = "10s"' 2 "shutdown propre app+bridge incomplet dans $(basename "$hcl")"
done

# Déploiement via les VERBES CONTRAINTS du bastion (constat C4 de
# AUDIT-EXPOSITION.md). La clé analytics-engine-ci-deploy@github porte une
# commande forcée `/usr/local/sbin/veridian-ci-deploy analytics-engine` : elle
# n'ouvre plus de shell et ne peut plus lire le jeton management Nomad.
#
# Les invariants d'exécution (pré-pull authentifié avec retry, `job validate`,
# `plan` fail-closed, `run -detach -check-index`, suivi du DeploymentID exact,
# sauvegardes pré-déploiement prod) ne sont donc plus assertables ICI : ils
# vivent dans le script serveur, hors de ce dépôt. Le contrat qui les décrit est
# ~/veridian/secrets-migration/C4-CONTRAT-CI.md sur le bastion.
#
# Ce que ce gate garde sous contrôle côté dépôt : les workflows passent bien par
# les verbes, et ne réouvrent jamais un shell distant.
require_fixed "$prod_ci" '"put-job prod" < "$JOB_FILE"' 'dépôt du HCL prod par put-job absent'
require_fixed "$prod_ci" '"deploy prod ${IMAGE_TAG}"' 'déploiement prod par verbe contraint absent'
require_fixed "$prod_ci" '"cleanup prod" || true' 'cleanup prod côté bastion absent'
require_fixed "$staging_ci" '"put-job staging" < "$JOB_FILE"' 'dépôt du HCL staging par put-job absent'
require_fixed "$staging_ci" '"deploy staging ${IMAGE_TAG}"' 'déploiement staging par verbe contraint absent'
require_fixed "$staging_ci" '"cleanup staging" || true' 'cleanup staging côté bastion absent'
require_fixed "$staging_ci" '"smoke staging"' 'smoke staging par verbe contraint absent'
reject_fixed "$prod_ci" 'bash -s"' 'shell distant réouvert sur le bastion depuis prod-ci'
reject_fixed "$staging_ci" 'bash -s"' 'shell distant réouvert sur le bastion depuis staging-deploy'
reject_fixed "$prod_ci" 'nomad-bastion.env' 'jeton Nomad encore sourcé depuis la CI prod'
reject_fixed "$staging_ci" 'nomad-bastion.env' 'jeton Nomad encore sourcé depuis la CI staging'
require_fixed "$prod_ci" '-o BatchMode=yes' 'BatchMode absent des SSH prod (clés en no-pty)'
require_fixed "$staging_ci" '-o BatchMode=yes' 'BatchMode absent des SSH staging (clés en no-pty)'
require_fixed "$structural" "'^deploy/.*\\.nomad\\.hcl$'" 'HCL Nomad absent du structural gate'
require_fixed "$onprem_gate" '- "deploy/*.nomad.hcl"' 'HCL Nomad absent du trigger E2E on-premise'
require_fixed "$onprem_gate" '- ".github/workflows/staging-deploy.yml"' 'workflow staging absent du trigger E2E on-premise'
require_fixed "$onprem_gate" '- ".github/workflows/prod-ci.yml"' 'workflow prod absent du trigger E2E on-premise'

echo 'OK: invariants GitOps Nomad Analytics'
