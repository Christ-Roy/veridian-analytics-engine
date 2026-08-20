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
# STATEFUL (volumes bind sur /opt/veridian-lab/analytics-engine d'ovh-prod) → group épinglé
# `provider=ovh-prod`. Secrets = Nomad Variable `nomad/jobs/analytics-engine` (jamais en clair).
# TLS = Let's Encrypt via l'ingress Traefik (websecure). engine+bridge bumpés par la CI.

variable "image_tag" {
  type        = string
  description = "Tag des images GHCR engine+bridge (prod-<sha7>). Injecté par la CI."
  default     = "prod-e48c79b"
}

job "analytics-engine" {
  datacenters = ["veridian-eu"]
  type        = "service"
  priority    = 80

  group "stack" {
    count = 1

    # Épinglé à ovh-prod : ClickHouse/pg-bridge utilisent des bind mounts locaux.
    constraint {
      attribute = "${meta.provider}"
      value     = "ovh-prod"
    }

    # Rollback idiomatique Nomad : si le nouveau déploiement n'atteint pas l'état
    # healthy (checks HTTP engine+bridge) sous healthy_deadline, Nomad REVIENT
    # automatiquement à la dernière version saine. Pas de job de rollback CI.
    update {
      max_parallel      = 1
      health_check      = "checks"
      min_healthy_time  = "15s"
      healthy_deadline  = "5m"
      progress_deadline = "10m"
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
      port "http" { to = 3000 }
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
        "traefik.http.routers.analytics-engine.middlewares=internal-only@nomad",
        "traefik.http.routers.analytics-enginesec.rule=Host(`analytics-engine-lab.veridian.site`)",
        "traefik.http.routers.analytics-enginesec.entrypoints=websecure",
        "traefik.http.routers.analytics-enginesec.middlewares=internal-only@nomad",
        "traefik.http.routers.analytics-enginesec.tls=true",
        "traefik.http.routers.analytics-engineprod.rule=Host(`analytics-engine.app.veridian.site`)",
        "traefik.http.routers.analytics-engineprod.entrypoints=websecure",
        "traefik.http.routers.analytics-engineprod.tls=true",
        "traefik.http.routers.analytics-engineprod.tls.certresolver=letsencrypt",
      ]
      check {
        type     = "http"
        path     = "/api/health"
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
        "traefik.http.routers.analytics-engine-bridge.middlewares=internal-only@nomad",
        "traefik.http.routers.analytics-engine-bridgesec.rule=Host(`analytics-engine-bridge-lab.veridian.site`)",
        "traefik.http.routers.analytics-engine-bridgesec.entrypoints=websecure",
        "traefik.http.routers.analytics-engine-bridgesec.middlewares=internal-only@nomad",
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
        cpu        = 500
        memory     = 512
        memory_max = 7000
      }
    }

    # ---- Postgres bridge (interne, frais) ----
    task "postgres-bridge" {
      driver = "docker"
      config {
        # Image officielle postgres:16-alpine + pgBackRest epingle. La BASE est
        # identique au bit pres : changer d'image de base changerait la
        # collation (musl/glibc) et fausserait silencieusement les index.
        image = "ghcr.io/christ-roy/veridian-postgres-pgbackrest:16-alpine@sha256:0da89e301ddd14d3f576505ce57a9b92d2c0bf44b72bb31dbaeef18c63a207ee"
        args = [
          # --- Archivage continu des WAL vers le depot pgBackRest ---
          # C'est CE reglage, et non la sauvegarde nocturne, qui borne la perte
          # de donnees : chaque segment de journal part vers R2 des qu'il est
          # clos. archive_timeout force cette cloture toutes les 5 minutes quand
          # il y a eu de l'ecriture, donc RPO = 5 min.
          # Modifier archive_mode exige un REDEMARRAGE de PostgreSQL (ce n'est
          # pas rechargeable a chaud) : c'est la seule interruption qu'impose la
          # mise en place.
          # pgBackRest ne joint le cluster QUE par socket Unix ; il n'a aucune
          # option de connexion TCP pour un cluster local. La tache annexe vit
          # dans un autre espace de montage et ne voit donc pas
          # /var/run/postgresql. On publie une seconde socket dans /alloc, le
          # repertoire que Nomad partage entre les taches d'un meme groupe.
          # L'ancienne reste en place : `docker exec ... psql` continue de marcher.
          "-c", "unix_socket_directories=/var/run/postgresql,/alloc",
          "-c", "archive_mode=on",
          "-c", "archive_command=pgbackrest --stanza=analytics-bridge archive-push %p",
          "-c", "archive_timeout=300",
          "-c", "wal_level=replica",
        ]
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
# --- pgBackRest : configuration par variables d'environnement ---
# Aucun fichier de configuration : les identifiants R2 et la phrase de
# chiffrement ne sont jamais ecrits sur le disque de l'allocation. pgBackRest
# lit toute option sous la forme PGBACKREST_<OPTION>.
PGBACKREST_REPO1_TYPE=s3
PGBACKREST_REPO1_PATH=/pgbackrest/analytics-bridge
PGBACKREST_REPO1_S3_REGION=auto
# path : R2 accepte les deux styles, celui-ci ne depend pas d'un DNS par bucket.
PGBACKREST_REPO1_S3_URI_STYLE=path
PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc
PGBACKREST_COMPRESS_TYPE=zst
PGBACKREST_COMPRESS_LEVEL=6
PGBACKREST_REPO1_BUNDLE=y
PGBACKREST_REPO1_BLOCK=y
PGBACKREST_LOG_LEVEL_CONSOLE=info
PGBACKREST_LOG_LEVEL_FILE=off
PGBACKREST_PG1_PATH=/var/lib/postgresql/data
PGBACKREST_PG1_PORT=5432
{{ with nomadVar "nomad/jobs/analytics-engine" }}
PGBACKREST_REPO1_S3_BUCKET={{ .R2_BUCKET }}
PGBACKREST_REPO1_S3_ENDPOINT={{ .R2_ENDPOINT }}
PGBACKREST_REPO1_S3_KEY={{ .R2_ACCESS_KEY_ID }}
PGBACKREST_REPO1_S3_KEY_SECRET={{ .R2_SECRET_ACCESS_KEY }}
# Utilisateur et base lus dans la MEME Variable que PostgreSQL lui-meme :
# les recopier en dur ici les ferait deriver en silence le jour ou ils changent.
PGBACKREST_PG1_USER={{ .BRIDGE_DB_USER }}
PGBACKREST_PG1_DATABASE={{ .BRIDGE_DB_NAME }}
# ATTENTION : PERDRE CETTE PHRASE = PERDRE TOUTES LES SAUVEGARDES. Copie de
# secours dans ~/credentials/.all-creds.env (PGBACKREST_CIPHER_ANALYTICS_BRIDGE).
PGBACKREST_REPO1_CIPHER_PASS={{ .PGBACKREST_CIPHER_PASS }}
{{ end }}
EOH
      }
      resources {
        cpu        = 200
        memory     = 256
        memory_max = 7000
      }
    }

    # ---- pgBackRest : sauvegarde continue vers R2 ----
    # Tache annexe du MEME groupe, donc : meme espace reseau (elle joint
    # PostgreSQL par la socket publiee dans /alloc, authentification `trust`
    # locale, aucun mot de passe a promener) et meme bind mount de PGDATA (elle
    # lit les pages directement). Elle SUIT l'allocation : si Nomad replace le
    # groupe, la sauvegarde repart sans qu'on touche a un script.
    task "pgbackrest" {
      driver = "docker"
      config {
        image      = "ghcr.io/christ-roy/veridian-postgres-pgbackrest:16-alpine@sha256:0da89e301ddd14d3f576505ce57a9b92d2c0bf44b72bb31dbaeef18c63a207ee"
        entrypoint = ["/usr/local/bin/pgbackrest-scheduler"]
        command    = ""
        volumes = [
          "/opt/veridian-lab/analytics-engine/pg-bridge:/var/lib/postgresql/data",
        ]
      }
      user = "postgres"

      template {
        destination = "secrets/pgbackrest.env"
        env         = true
        data        = <<EOH
TZ=UTC
PGBR_STANZA=analytics-bridge
# Socket partagee avec la tache postgres via le repertoire d'allocation.
PGBACKREST_PG1_SOCKET_PATH=/alloc
# Complete le dimanche, differentielle les autres jours, incrementale toutes les
# 6 h. 45 : creneau propre a cette stanza pour ne pas taper R2 en meme
# temps que les autres bases du parc.
PGBR_FULL_DOW=0
PGBR_DAILY_HOUR=3
PGBR_DAILY_MINUTE=45
PGBR_INCR_EVERY_H=6
# Base de PRODUCTION cliente : 8 semaines de completes conservees. Les WAL
# retenus couvrent la meme profondeur, donc on peut viser n'importe quelle
# seconde des deux derniers mois.
PGBACKREST_REPO1_RETENTION_FULL=8
PGBACKREST_REPO1_RETENTION_DIFF=7
PGBACKREST_PROCESS_MAX=2
PGBACKREST_START_FAST=y
# --- pgBackRest : configuration par variables d'environnement ---
# Aucun fichier de configuration : les identifiants R2 et la phrase de
# chiffrement ne sont jamais ecrits sur le disque de l'allocation. pgBackRest
# lit toute option sous la forme PGBACKREST_<OPTION>.
PGBACKREST_REPO1_TYPE=s3
PGBACKREST_REPO1_PATH=/pgbackrest/analytics-bridge
PGBACKREST_REPO1_S3_REGION=auto
# path : R2 accepte les deux styles, celui-ci ne depend pas d'un DNS par bucket.
PGBACKREST_REPO1_S3_URI_STYLE=path
PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc
PGBACKREST_COMPRESS_TYPE=zst
PGBACKREST_COMPRESS_LEVEL=6
PGBACKREST_REPO1_BUNDLE=y
PGBACKREST_REPO1_BLOCK=y
PGBACKREST_LOG_LEVEL_CONSOLE=info
PGBACKREST_LOG_LEVEL_FILE=off
PGBACKREST_PG1_PATH=/var/lib/postgresql/data
PGBACKREST_PG1_PORT=5432
{{ with nomadVar "nomad/jobs/analytics-engine" }}
PGBACKREST_REPO1_S3_BUCKET={{ .R2_BUCKET }}
PGBACKREST_REPO1_S3_ENDPOINT={{ .R2_ENDPOINT }}
PGBACKREST_REPO1_S3_KEY={{ .R2_ACCESS_KEY_ID }}
PGBACKREST_REPO1_S3_KEY_SECRET={{ .R2_SECRET_ACCESS_KEY }}
# Utilisateur et base lus dans la MEME Variable que PostgreSQL lui-meme :
# les recopier en dur ici les ferait deriver en silence le jour ou ils changent.
PGBACKREST_PG1_USER={{ .BRIDGE_DB_USER }}
PGBACKREST_PG1_DATABASE={{ .BRIDGE_DB_NAME }}
# ATTENTION : PERDRE CETTE PHRASE = PERDRE TOUTES LES SAUVEGARDES. Copie de
# secours dans ~/credentials/.all-creds.env (PGBACKREST_CIPHER_ANALYTICS_BRIDGE).
PGBACKREST_REPO1_CIPHER_PASS={{ .PGBACKREST_CIPHER_PASS }}
{{ end }}
EOH
      }

      resources {
        cpu        = 100
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
        name     = "analytics-engine-selfheal"
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
        memory     = 384
        memory_max = 7000
      }
    }

    # ---- Bridge (port 3002) — bumpé par la CI ----
    task "bridge" {
      driver         = "docker"
      shutdown_delay = "10s"
      kill_timeout   = "30s"

      service {
        name     = "analytics-engine-bridge-selfheal"
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
        cpu        = 300
        memory     = 192
        memory_max = 7000
      }
    }
  }
}
