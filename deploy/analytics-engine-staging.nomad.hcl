# analytics-engine-staging — STAGING — job Nomad versionné (GitOps, source de vérité DANS ce repo).
#
# Placé sur ovh-dev (provider=ovh-dev), servi via l'ingress bastion (cross-node Tailscale).
# PRIVÉ Tailscale : middleware internal-only (ipAllowList 100.64/10) → 403 hors tailnet, ET
# host_network="tailscale" sur chaque port → app injoignable en public (double verrou).
# ClickHouse + Postgres bridge STATEFUL (bind /opt/veridian-staging/analytics du nœud ovh-dev)
# → group épinglé `provider=ovh-dev`. Secrets = Nomad Variable `nomad/jobs/analytics-engine-staging`.
#
# La CI (staging-deploy.yml) build+push engine+bridge au tag `staging-<sha>` puis
# SSH → bastion → `nomad job plan -var image_tag=staging-<sha>` → `run -detach`.

variable "image_tag" {
  type        = string
  description = "Tag des images GHCR engine+bridge (staging-<sha7>). Injecté par la CI."
  default     = "staging-54abb67"
}

job "analytics-engine-staging" {
  datacenters = ["veridian-eu"]
  type        = "service"
  priority    = 50

  group "stack" {
    count = 1

    # Scale-to-zero Sablier : les routes permanentes de l'ingress ciblent les
    # ports statiques 19102/19103 et réveillent ce job par son nom.
    meta = { "sablier.enable" = "true" }

    # Épinglé à ovh-dev : les DB bind sur /opt/veridian-staging du nœud ovh-dev uniquement.
    constraint {
      attribute = "${meta.provider}"
      value     = "ovh-dev"
    }

    # Rollback idiomatique Nomad : auto-revert à la dernière version saine si le
    # nouveau déploiement échoue ses health checks. Pas de job de rollback CI.
    update {
      max_parallel      = 1
      health_check      = "checks"
      min_healthy_time  = "10s"
      healthy_deadline  = "15m"
      progress_deadline = "20m"
      auto_revert       = true
    }

    restart {
      attempts = 10
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    network {
      mode = "bridge"
      # host_network tailscale : les ports CNI bind sur l'IP Tailscale du nœud uniquement
      # → apps injoignables en public, Traefik route via Tailscale.
      port "http" {
        static       = 19102
        to           = 3000
        host_network = "tailscale"
      }
      port "bridge" {
        static       = 19103
        to           = 3002
        host_network = "tailscale"
      }
    }

    # engine → console analytics (exposé)
    service {
      name     = "analytics-engine-staging"
      provider = "nomad"
      port     = "http"
      # Le routage est déclaré une seule fois dans ingress.nomad.hcl (@file).
      tags = ["traefik.enable=false"]
      check {
        type     = "http"
        path     = "/api/health"
        interval = "5s"
        timeout  = "5s"
      }
    }

    # bridge Veridian (exposé)
    service {
      name     = "analytics-bridge-staging"
      provider = "nomad"
      port     = "bridge"
      tags = ["traefik.enable=false"]
      check {
        type     = "http"
        path     = "/health"
        interval = "5s"
        timeout  = "5s"
      }
    }

    # ---- ClickHouse (interne, données staging migrées) ----
    task "clickhouse" {
      driver = "docker"
      config {
        image = "clickhouse/clickhouse-server:24.8"
        volumes = [
          "/opt/veridian-staging/analytics/clickhouse:/var/lib/clickhouse",
          "/opt/veridian-staging/analytics/clickhouse-users.xml:/etc/clickhouse-server/users.d/users.xml:ro",
          "local/clickhouse-system-logs.xml:/etc/clickhouse-server/config.d/system-logs.xml:ro",
        ]
        ulimit { nofile = "262144:262144" }
      }
      # Les valeurs par défaut ClickHouse 24.8 gardent les logs système sans
      # TTL, avec logger/text_log en trace et metric_log toutes les secondes.
      # Staging conserve 7 jours de diagnostic, sans croissance non bornée.
      template {
        destination = "local/clickhouse-system-logs.xml"
        change_mode = "restart"
        data        = <<CLICKHOUSE_SYSTEM_LOGS_XML
<clickhouse>
  <logger>
    <level>information</level>
    <size>100M</size>
    <count>3</count>
  </logger>
  <text_log>
    <level>information</level>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </text_log>
  <metric_log>
    <collect_interval_milliseconds>5000</collect_interval_milliseconds>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </metric_log>
  <asynchronous_metric_log>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </asynchronous_metric_log>
  <trace_log>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </trace_log>
  <processors_profile_log>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </processors_profile_log>
  <query_log>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </query_log>
  <part_log>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </part_log>
  <error_log>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </error_log>
  <query_views_log>
    <ttl>event_date + INTERVAL 7 DAY</ttl>
  </query_views_log>
</clickhouse>
CLICKHOUSE_SYSTEM_LOGS_XML
      }
      template {
        destination = "secrets/ch.env"
        env         = true
        data        = <<EOH
TZ=UTC
CLICKHOUSE_DB=staminads_system
CLICKHOUSE_USER=default
CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1
{{ with nomadVar "nomad/jobs/analytics-engine-staging" }}
CLICKHOUSE_PASSWORD={{ .CLICKHOUSE_PASSWORD }}
{{ end }}
EOH
      }
      resources {
        cpu        = 500
        memory     = 1024
        # Pic 7 j observé : 1 334 MiB. Fusible x2,3 sans pouvoir affamer la VM.
        memory_max = 3072
      }
    }

    # ---- Postgres bridge (interne, données staging migrées) ----
    task "postgres-bridge" {
      driver = "docker"
      config {
        image = "postgres:16-alpine"
        volumes = [
          "/opt/veridian-staging/analytics/pg-bridge:/var/lib/postgresql/data",
        ]
      }
      template {
        destination = "secrets/pg.env"
        env         = true
        data        = <<EOH
TZ=UTC
{{ with nomadVar "nomad/jobs/analytics-engine-staging" }}
POSTGRES_DB={{ .BRIDGE_DB_NAME }}
POSTGRES_USER={{ .BRIDGE_DB_USER }}
POSTGRES_PASSWORD={{ .BRIDGE_DB_PASSWORD }}
{{ end }}
EOH
      }
      resources {
        # Pics 7 j observés : 25 MHz / 19 MiB.
        cpu        = 50
        memory     = 64
        memory_max = 512
      }
    }

    # ---- Engine (console analytics, port 3000) — bumpé par la CI ----
    task "engine" {
      driver         = "docker"
      shutdown_delay = "10s"
      kill_timeout   = "30s"

      service {
        name     = "analytics-engine-staging-selfheal"
        provider = "nomad"
        port     = "http"
        tags     = ["traefik.enable=false"]
        check {
          type     = "http"
          path     = "/api/health"
          interval = "15s"
          timeout  = "5s"
          check_restart {
            limit           = 4
            grace           = "120s"
            ignore_warnings = false
          }
        }
      }

      config {
        image = "ghcr.io/christ-roy/veridian-analytics-engine:${var.image_tag}"
        init  = true
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
VOIP_SYNC_ENABLED=false
CLICKHOUSE_HOST=http://127.0.0.1:8123
CLICKHOUSE_SYSTEM_DATABASE=staminads_system
CLICKHOUSE_DATABASE=staminads
CLICKHOUSE_USER=default
SMTP_FROM_EMAIL=noreply@veridian.site
SMTP_FROM_NAME=Veridian Analytics
SMTP_PORT=587
APP_URL=https://analytics-engine.staging.veridian.site
CORS_ALLOWED_ORIGINS=https://analytics-engine.staging.veridian.site,https://analytics-engine-bridge.staging.veridian.site,https://hub.staging.veridian.site
{{ with nomadVar "nomad/jobs/analytics-engine-staging" }}
CLICKHOUSE_PASSWORD={{ .CLICKHOUSE_PASSWORD }}
ENCRYPTION_KEY={{ .ENCRYPTION_KEY }}
PLATFORM_ADMIN_API_KEY={{ .PLATFORM_ADMIN_API_KEY }}
# Secret HMAC partagé avec le Hub, requis par HubHmacGuard (routes SSO).
# Même valeur que celle déjà servie au bridge ci-dessous, et que le Hub nomme
# ANALYTICS_HUB_API_SECRET de son côté. Sans cette variable, l'engine
# refusera TOUTES les demandes d'autologin (fail-closed volontaire).
HUB_HMAC_SECRET={{ .HUB_HMAC_SECRET }}
{{ end }}
EOH
      }
      resources {
        cpu        = 400
        # Pic 7 j observé : 142 MiB, réserve +35 %, fusible x7.
        memory     = 192
        memory_max = 1024
      }
    }

    # ---- Bridge (port 3002) — bumpé par la CI ----
    task "bridge" {
      driver         = "docker"
      shutdown_delay = "10s"
      kill_timeout   = "30s"

      service {
        name     = "analytics-bridge-staging-selfheal"
        provider = "nomad"
        port     = "bridge"
        tags     = ["traefik.enable=false"]
        check {
          type     = "http"
          path     = "/health"
          interval = "15s"
          timeout  = "5s"
          check_restart {
            limit           = 4
            grace           = "90s"
            ignore_warnings = false
          }
        }
      }

      config {
        image = "ghcr.io/christ-roy/veridian-analytics-bridge:${var.image_tag}"
        init  = true
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
PUBLIC_STAMINADS_URL=https://analytics-engine.staging.veridian.site
PUBLIC_DASHBOARD_URL=https://analytics.app.veridian.site
SKIP_HMAC=false
BRIDGE_DB_HOST=127.0.0.1
BRIDGE_DB_PORT=5432
{{ with nomadVar "nomad/jobs/analytics-engine-staging" }}
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
        # Pics 7 j observés : 11 MHz / 65 MiB.
        cpu        = 50
        memory     = 96
        memory_max = 512
      }
    }
  }
}
