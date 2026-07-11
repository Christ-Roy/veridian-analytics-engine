# analytics-engine — PROD — job Nomad versionné (GitOps, source de vérité DANS ce repo).
#
# Déployé sur le cluster Nomad Veridian (3 nœuds, migration Dokploy→Nomad terminée
# 2026-07-10). La CI (prod-ci.yml) build+push les images engine+bridge sur GHCR au tag
# `prod-<sha>`, puis SSH → bastion → `nomad job plan -var image_tag=prod-<sha>` → `run -detach`.
#
# ⚠️ Ce fichier DÉCLARE `variable "image_tag"` — c'est la copie de vérité que la CI déploie
# (PAS la copie ~/nomad-veridian/jobs/analytics-engine.nomad.hcl du bastion, sans variable →
# `-var image_tag` échouerait). Aligner les deux si l'infra édite le job à la main.
#
# 4 composants dans UN group (namespace réseau bridge partagé) → 127.0.0.1 (remplace les
# hostnames compose clickhouse/postgres-bridge/engine). ClickHouse + Postgres bridge sont
# STATEFUL (volumes bind sur /opt/veridian-lab/analytics-engine du bastion) → group épinglé
# `provider=contabo`. Secrets = Nomad Variable `nomad/jobs/analytics-engine` (jamais en clair).
# TLS = Let's Encrypt via l'ingress Traefik (websecure). engine+bridge bumpés par la CI.

variable "image_tag" {
  type        = string
  description = "Tag des images GHCR engine+bridge (prod-<sha7>). Injecté par la CI."
  default     = "prod-b95e022"
}

job "analytics-engine" {
  datacenters = ["veridian-eu"]
  type        = "service"

  group "stack" {
    count = 1

    # Épinglé au bastion : clickhouse/pg-bridge bind sur /opt/veridian-lab/analytics-engine du bastion uniquement.
    constraint {
      attribute = "${meta.provider}"
      value     = "contabo"
    }

    restart {
      attempts = 10
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    network {
      mode = "bridge"
      port "http"   { to = 3000 }
      port "bridge" { to = 3002 }
    }

    # engine → console analytics (exposé)
    service {
      name     = "analytics-engine"
      provider = "nomad"
      port     = "http"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.analytics-engine.rule=Host(`analytics-engine-lab.veridian.site`)",
        "traefik.http.routers.analytics-engine.entrypoints=web",
        "traefik.http.routers.analytics-enginesec.rule=Host(`analytics-engine-lab.veridian.site`)",
        "traefik.http.routers.analytics-enginesec.entrypoints=websecure",
        "traefik.http.routers.analytics-enginesec.tls=true",
        "traefik.http.routers.analytics-engineprod.rule=Host(`analytics-engine.app.veridian.site`)",
        "traefik.http.routers.analytics-engineprod.entrypoints=websecure",
        "traefik.http.routers.analytics-engineprod.tls=true",
        "traefik.http.routers.analytics-engineprod.tls.certresolver=letsencrypt",
      ]
      check {
        type     = "http"
        path     = "/api/setup.status"
        interval = "15s"
        timeout  = "5s"
      }
    }

    # bridge Veridian (exposé)
    service {
      name     = "analytics-engine-bridge"
      provider = "nomad"
      port     = "bridge"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.analytics-engine-bridge.rule=Host(`analytics-engine-bridge-lab.veridian.site`)",
        "traefik.http.routers.analytics-engine-bridge.entrypoints=web",
        "traefik.http.routers.analytics-engine-bridgesec.rule=Host(`analytics-engine-bridge-lab.veridian.site`)",
        "traefik.http.routers.analytics-engine-bridgesec.entrypoints=websecure",
        "traefik.http.routers.analytics-engine-bridgesec.tls=true",
        "traefik.http.routers.analytics-engine-bridgeprod.rule=Host(`analytics-engine-bridge.app.veridian.site`)",
        "traefik.http.routers.analytics-engine-bridgeprod.entrypoints=websecure",
        "traefik.http.routers.analytics-engine-bridgeprod.tls=true",
        "traefik.http.routers.analytics-engine-bridgeprod.tls.certresolver=letsencrypt",
      ]
      check {
        type     = "http"
        path     = "/health"
        interval = "15s"
        timeout  = "5s"
      }
    }

    # ---- ClickHouse (interne, frais) ----
    task "clickhouse" {
      driver = "docker"
      config {
        image = "clickhouse/clickhouse-server:24.8"
        volumes = [
          "/opt/veridian-lab/analytics-engine/clickhouse:/var/lib/clickhouse",
          "/opt/veridian-lab/analytics-engine/clickhouse-users.xml:/etc/clickhouse-server/users.d/users.xml:ro",
        ]
        ulimit { nofile = "262144:262144" }
      }
      template {
        destination = "secrets/ch.env"
        env         = true
        data        = <<EOH
TZ=UTC
CLICKHOUSE_DB=staminads_system
CLICKHOUSE_USER=default
CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1
{{ with nomadVar "nomad/jobs/analytics-engine" }}
CLICKHOUSE_PASSWORD={{ .CLICKHOUSE_PASSWORD }}
{{ end }}
EOH
      }
      resources {
        cpu    = 500
        memory = 3072
      }
    }

    # ---- Postgres bridge (interne, frais) ----
    task "postgres-bridge" {
      driver = "docker"
      config {
        image = "postgres:16-alpine"
        volumes = [
          "/opt/veridian-lab/analytics-engine/pg-bridge:/var/lib/postgresql/data",
        ]
      }
      template {
        destination = "secrets/pg.env"
        env         = true
        data        = <<EOH
TZ=UTC
{{ with nomadVar "nomad/jobs/analytics-engine" }}
POSTGRES_DB={{ .BRIDGE_DB_NAME }}
POSTGRES_USER={{ .BRIDGE_DB_USER }}
POSTGRES_PASSWORD={{ .BRIDGE_DB_PASSWORD }}
{{ end }}
EOH
      }
      resources {
        cpu    = 200
        memory = 256
      }
    }

    # ---- Engine (console analytics, port 3000) — bumpé par la CI ----
    task "engine" {
      driver = "docker"
      config {
        image = "ghcr.io/christ-roy/veridian-analytics-engine:${var.image_tag}"
        ports = ["http"]
      }
      template {
        destination = "secrets/engine.env"
        env         = true
        data        = <<EOH
TZ=UTC
PORT=3000
NODE_ENV=production
JWT_EXPIRES_IN=7d
IS_DEMO=false
SUBSCRIPTIONS_ENABLED=false
CLICKHOUSE_HOST=http://127.0.0.1:8123
CLICKHOUSE_SYSTEM_DATABASE=staminads_system
CLICKHOUSE_DATABASE=staminads
CLICKHOUSE_USER=default
APP_URL=https://analytics-engine.app.veridian.site
CORS_ALLOWED_ORIGINS=https://analytics-engine.app.veridian.site,https://analytics-engine-bridge.app.veridian.site,https://app.veridian.site
{{ with nomadVar "nomad/jobs/analytics-engine" }}
CLICKHOUSE_PASSWORD={{ .CLICKHOUSE_PASSWORD }}
ENCRYPTION_KEY={{ .ENCRYPTION_KEY }}
PLATFORM_ADMIN_API_KEY={{ .PLATFORM_ADMIN_API_KEY }}
DEMO_SECRET={{ .DEMO_SECRET }}
{{ end }}
EOH
      }
      resources {
        cpu    = 400
        memory = 512
      }
    }

    # ---- Bridge (port 3002) — bumpé par la CI ----
    task "bridge" {
      driver = "docker"
      config {
        image = "ghcr.io/christ-roy/veridian-analytics-bridge:${var.image_tag}"
        ports = ["bridge"]
      }
      template {
        destination = "secrets/bridge.env"
        env         = true
        data        = <<EOH
TZ=UTC
PORT=3002
NODE_ENV=production
STAMINADS_URL=http://127.0.0.1:3000
PUBLIC_STAMINADS_URL=https://analytics-engine.app.veridian.site
PUBLIC_DASHBOARD_URL=https://analytics-engine.app.veridian.site
SKIP_HMAC=false
BRIDGE_DB_HOST=127.0.0.1
BRIDGE_DB_PORT=5432
{{ with nomadVar "nomad/jobs/analytics-engine" }}
PLATFORM_ADMIN_API_KEY={{ .PLATFORM_ADMIN_API_KEY }}
VERIDIAN_ADMIN_API_KEY={{ .VERIDIAN_ADMIN_API_KEY }}
HUB_HMAC_SECRET={{ .HUB_HMAC_SECRET }}
TOKEN_ENCRYPTION_KEY={{ .TOKEN_ENCRYPTION_KEY }}
BRIDGE_DB_USER={{ .BRIDGE_DB_USER }}
BRIDGE_DB_PASSWORD={{ .BRIDGE_DB_PASSWORD }}
BRIDGE_DB_NAME={{ .BRIDGE_DB_NAME }}
BRIDGE_DATABASE_URL=postgresql://{{ .BRIDGE_DB_USER }}:{{ .BRIDGE_DB_PASSWORD }}@127.0.0.1:5432/{{ .BRIDGE_DB_NAME }}
{{ end }}
EOH
      }
      resources {
        cpu    = 300
        memory = 384
      }
    }
  }
}
