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
#
# ---------------------------------------------------------------------------
# BUDGET MÉMOIRE — recalibré le 2026-08-18, d'où vient la place
# ---------------------------------------------------------------------------
# Réservations : 512+256+384+192 = 1344 MiB  →  2048+128+384+192 = 2752 MiB
# Delta = +1408 MiB. ovh-prod : 9628 MiB ordonnançables, 8684 réservés,
# donc 944 MiB libres. Les 464 MiB manquants ne se prennent à personne :
# `odh-google-maps-worker-soak-prod2` réserve 1024 MiB en batch priorité 7,
# déclaré `preemptible=true` / `checkpoint` dans WORKLOAD-CONTRACTS.tsv, et
# la préemption batch est activée au niveau du scheduler. analytics-engine
# est priorité 80 : il préempte, le soak reprend sur son checkpoint. C'est
# le mécanisme prévu, pas un arbitrage au détriment d'un service client.
#
# Il n'y avait AUCUN gras à reprendre sur ovh-prod : sur 36 tâches mesurées
# sur 30 j, la plus grasse (hors la nôtre) est à 14 % de sa réservation pour
# 128 MiB. Le nœud n'est pas gaspilleur, il est sous-réservé — d'où le
# réflexe collectif d'ouvrir les `memory_max`, qui masque le symptôme.
# ---------------------------------------------------------------------------

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
      # Mesuré le 2026-08-18 sur 30 j (Grafana Cloud, ratio conso/réservé —
      # jamais les absolus, faussés par le doublement pendant les déploiements).
      #
      # Pourquoi ces chiffres, et pas 512 / 7000 :
      # ClickHouse 24.8 lit la limite CGROUP, donc `memory_max`, PAS `memory`.
      # Sous le plafond de 7000 il s'attribuait `max_server_memory_usage` =
      # 0,9 × 6,84 GiB = 6,15 GiB et dimensionnait ses caches dessus
      # (mark_cache 5 GiB, uncompressed_cache 8 GiB), pour une réservation
      # déclarée de 512 MiB. Le plafond ne bornait pas la consommation :
      # il la FABRIQUAIT. Mesures à l'appui, même binaire, même charge :
      #   plafond 7000 (prod)    → pic 1679 MiB (328 % de la réservation)
      #   plafond 3072 (staging) → pic 1354 MiB (264 % de la réservation)
      # La consommation suit le plafond, pas le travail réel.
      #
      # memory     = 2048 : le pic réel entre DANS la réservation, donc le
      #   scheduler place enfin la tâche pour ce qu'elle pèse (avant, il la
      #   croyait 3 fois plus petite qu'elle n'était).
      # memory_max = 3072 : vrai fusible. 1,5 × la réservation, et surtout
      #   ovh-prod n'a que 11,4 GiB : un plafond de 7000 sur une tâche parmi
      #   les 11 qui le portaient laissait le noyau OOM-killer arbitrer à
      #   l'échelle du NŒUD. Un fusible doit griller la tâche fautive, pas
      #   emporter les autres services de production avec elle.
      #
      # Ne pas rouvrir ce plafond pour « laisser de l'air » à ClickHouse :
      # c'est le geste qui a créé le problème (commit 9b264f0, [skip ci]).
      # Si ClickHouse manque vraiment de mémoire, monter `memory` — pas le max.
      resources {
        cpu        = 500
        memory     = 2048
        memory_max = 3072
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
      # Mesuré 2026-08-18 / 30 j : pic 40 MiB, soit 14 % de la réservation.
      # 128 MiB reste 3,2 × le pic ; les 128 MiB rendus financent ClickHouse
      # ci-dessus. Fusible à 512 = 4 × la réservation, largement de quoi
      # encaisser un VACUUM ou une reindexation sans menacer le nœud.
      resources {
        cpu        = 200
        memory     = 128
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
      # Mesuré 2026-08-18 / 30 j : pic 184 MiB, soit 48 % de la réservation.
      # 384 MiB = 2,1 × le pic, on garde. Fusible à 1024 = 2,7 × la
      # réservation : de quoi encaisser un pic de requêtes console sans
      # laisser une fuite Node emporter le nœud.
      resources {
        cpu        = 400
        memory     = 384
        memory_max = 1024
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
      # Mesuré 2026-08-18 / 30 j : pic 67 MiB, soit 35 % de la réservation.
      # 192 MiB = 2,9 × le pic, on garde. Fusible à 512 = 2,7 × la réservation.
      resources {
        cpu        = 300
        memory     = 192
        memory_max = 512
      }
    }
  }
}
