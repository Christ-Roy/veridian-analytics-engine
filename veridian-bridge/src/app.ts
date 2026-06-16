/**
 * Bridge Veridian POC — factory Express
 *
 * Sortie de l'app dans une factory pour être testable en intégration sans
 * dépendre de process.env ou d'un app.listen global. Les tests injectent
 * leur propre config (URL d'un faux staminads, API key, etc.).
 */

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import {
  createTenantStatusBuilder,
  makeStaminadsPageviewsFetcher,
  type PageviewsFetcher,
} from "./tenant-status.js";
import {
  createCheckTrackerHandler,
  makeStaminadsRecentActivityFetcher,
  type RecentActivityFetcher,
} from "./check-tracker.js";
import { SHADOW_MARKETING } from "./shadow-marketing.js";
import { buildCountsFromStaminadsRows, computeScore } from "./score.js";
import { hubHmacMiddleware } from "./hub-hmac.js";
import {
  InMemoryTenantStore,
  type TenantRecord,
  type TenantStore,
} from "./hub/store.js";
import { provisionHandler } from "./hub/provision.js";
import { attachOwnerHandler } from "./hub/attach-owner.js";
import { healthHandler, type HealthStats } from "./hub/health.js";
import {
  createEngineM2mClient,
  EngineM2mError,
  type EngineM2mClient,
} from "./engine-m2m.js";

export interface BridgeConfig {
  staminadsUrl: string;
  /**
   * URL publique de staminads à coller dans le snippet tracker côté sites clients.
   * Optionnel : si absent, fallback sur staminadsUrl (utile en dev local).
   * Ex en staging : https://analytics-engine.staging.veridian.site
   */
  publicStaminadsUrl?: string;
  /**
   * Clé M2M partagée bridge ↔ Engine (Bearer PLATFORM_ADMIN_API_KEY côté
   * Engine `PlatformAdminGuard`). Remplace l'ancien couple
   * adminEmail/adminPassword (anti-pattern super_admin login, retiré 2026-06-16).
   */
  platformAdminApiKey: string;
  veridianAdminApiKey: string;
  /**
   * Hub integration (B3). Si absent, les routes `/api/tenants/*` sont
   * montées avec un store en mémoire et un secret par défaut "dev-secret"
   * (utile pour les tests anciens qui ne touchent pas Hub).
   */
  hub?: {
    /** Secret HMAC partagé Hub ↔ bridge (32+ chars). */
    hmacSecret: string;
    /** Bypass HMAC en dev (SKIP_HMAC=true), refusé en prod/staging. */
    skipHmac?: boolean;
    /** Store custom (Prisma plus tard). Default : InMemoryTenantStore. */
    store?: TenantStore;
    /** URL publique dashboard renvoyée par /provision. */
    publicDashboardUrl?: string;
    /** Hook stats pour /health (optionnel). */
    loadStats?(tenant: TenantRecord): Promise<HealthStats>;
    /**
     * Hook staminads pour /provision. Si absent, on appelle l'API staminads
     * via `cfg.staminadsUrl` (path par défaut). Les tests injectent un fake.
     */
    createStaminadsWorkspace?(input: {
      hubTenantId: string;
      workspaceName: string;
      ownerEmail: string;
    }): Promise<{ workspaceId: string; apiKey: string }>;
  };
}

const ProvisionSchema = z.object({
  tenantSlug: z.string().min(1).max(64),
  tenantName: z.string().min(1).max(120),
  website: z.string().url(),
  timezone: z.string().default("UTC"),
  currency: z.string().default("EUR"),
});

const TrackTestSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .default(() => `poc-sess-${Date.now()}`),
  paths: z.array(z.string()).default(["/", "/pricing", "/contact"]),
});

export function validateConfig(cfg: BridgeConfig): void {
  if (!cfg.veridianAdminApiKey || cfg.veridianAdminApiKey.length < 32) {
    throw new Error("veridianAdminApiKey missing or too short (need >= 32 chars)");
  }
  if (!cfg.staminadsUrl.startsWith("http")) {
    throw new Error("staminadsUrl must be a valid http(s) URL");
  }
  if (!cfg.platformAdminApiKey || cfg.platformAdminApiKey.length < 32) {
    throw new Error(
      "platformAdminApiKey missing or too short (need >= 32 chars)",
    );
  }
}

/**
 * Options optionnelles pour `createApp`. Permet d'injecter des dépendances
 * mockables (utile pour les tests qui veulent piloter les counts staminads
 * sans monter un faux serveur HTTP).
 */
export interface CreateAppOptions {
  /**
   * Override du fetcher pageviews 30j utilisé par `/api/admin/tenant/:id/status`.
   * Par défaut, on en construit un qui interroge staminads via analytics.query.
   */
  pageviewsFetcher?: PageviewsFetcher;
  /**
   * Override du fetcher d'activité récente utilisé par
   * `/api/admin/tenant/:id/check-tracker` (onboarding wizard U4). Par défaut,
   * on en construit un qui interroge staminads via analytics.query (24h).
   */
  recentActivityFetcher?: RecentActivityFetcher;
  /**
   * Override du client M2M Engine (provision + analytics). Par défaut, on en
   * construit un qui tape `/api/admin/platform/*` avec
   * `cfg.platformAdminApiKey`. Les tests injectent un fake.
   */
  engineM2m?: EngineM2mClient;
}

export function createApp(cfg: BridgeConfig, opts: CreateAppOptions = {}): Express {
  validateConfig(cfg);

  const app = express();
  // express.json() global SAUF sur /api/tenants/* qui utilisent un middleware
  // HMAC qui lit le raw body lui-même (signature sur les octets bruts).
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/tenants/")) return next();
    return express.json({ limit: "256kb" })(req, res, next);
  });

  // Client M2M natif Engine — remplace l'anti-pattern getAdminToken
  // (super_admin email/password + JWT caché 6j). Auth = un seul secret
  // partagé Bearer PLATFORM_ADMIN_API_KEY, validé timing-safe côté Engine
  // (PlatformAdminGuard). Cf. src/engine-m2m.ts + docs/PLATFORM-ADMIN-API.md.
  const engineM2m: EngineM2mClient =
    opts.engineM2m ??
    createEngineM2mClient({
      engineUrl: cfg.staminadsUrl,
      platformAdminApiKey: cfg.platformAdminApiKey,
    });

  function requireVeridianAdmin(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer" });
      return;
    }
    const token = auth.slice("Bearer ".length).trim();
    if (token !== cfg.veridianAdminApiKey) {
      res.status(403).json({ error: "invalid_admin_key" });
      return;
    }
    next();
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", staminadsUrl: cfg.staminadsUrl });
  });

  app.post("/api/admin/provision-tenant", requireVeridianAdmin, async (req, res) => {
    const parsed = ProvisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }

    try {
      // Endpoint POC interne (le flux Hub réel passe par /api/tenants/provision
      // HMAC). Le natif tenants.provision exige un email owner — ce POC n'en a
      // pas, on dérive un email de service bot+<slug>@veridian.site (jamais
      // utilisé pour un vrai login : le user owner est piloté par le Hub via
      // le flux HMAC). Le natif slugifie lui-même name → workspace_id.
      const slug = parsed.data.tenantSlug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
      const derivedEmail = `bot+${slug || "tenant"}@veridian.site`;

      let result;
      try {
        result = await engineM2m.provisionTenant({
          email: derivedEmail,
          siteUrl: parsed.data.website,
          name: parsed.data.tenantName,
          timezone: parsed.data.timezone,
          currency: parsed.data.currency,
        });
      } catch (err) {
        if (err instanceof EngineM2mError) {
          res.status(502).json({
            error: "provision_failed",
            status: err.status,
            body: err.body,
          });
          return;
        }
        throw err;
      }

      res.json({
        tenantSlug: parsed.data.tenantSlug,
        staminadsWorkspaceId: result.workspace_id,
        staminadsApiKey: result.api_key,
        trackingSnippet: {
          workspaceId: result.workspace_id,
          // URL publique du tracker (à coller dans le <script> côté site client)
          endpoint: cfg.publicStaminadsUrl ?? cfg.staminadsUrl,
        },
      });
    } catch (err) {
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  });

  app.post("/api/admin/track-test", requireVeridianAdmin, async (req, res) => {
    const parsed = TrackTestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }

    const now = Date.now();
    const actions: Array<Record<string, unknown>> = parsed.data.paths.map(
      (path, idx) => ({
        type: "pageview",
        path,
        page_number: idx + 1,
        duration: 12_000 + idx * 5_000,
        scroll: 60 + idx * 10,
        entered_at: now - (parsed.data.paths.length - idx) * 15_000,
        exited_at: now - (parsed.data.paths.length - idx - 1) * 15_000,
      })
    );
    actions.push({
      type: "goal",
      name: "poc_signup",
      path: parsed.data.paths.at(-1) ?? "/",
      page_number: actions.length,
      timestamp: now,
    });

    const payload = {
      workspace_id: parsed.data.workspaceId,
      session_id: parsed.data.sessionId,
      created_at: now - 60_000,
      updated_at: now,
      sdk_version: "veridian-poc-0.1",
      actions,
      attributes: {
        landing_page: "https://demo.veridian.site" + parsed.data.paths[0],
        utm_source: "veridian-poc",
        utm_medium: "smoke-test",
        utm_campaign: "engine-validation",
        device: "desktop",
        browser: "Firefox",
        os: "Linux",
        language: "fr-FR",
        timezone: "Europe/Paris",
      },
    };

    try {
      const trackRes = await fetch(`${cfg.staminadsUrl}/api/track`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://demo.veridian.site",
          referer: "https://demo.veridian.site/",
        },
        body: JSON.stringify(payload),
      });

      if (!trackRes.ok) {
        const text = await trackRes.text();
        res
          .status(502)
          .json({ error: "track_failed", status: trackRes.status, body: text });
        return;
      }

      res.json({
        ok: true,
        sessionId: parsed.data.sessionId,
        actionsSent: actions.length,
      });
    } catch (err) {
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  });

  /**
   * GET /api/admin/tenant/:workspaceId/score
   *
   * Renvoie le Score Veridian global pour un workspace staminads donné.
   * Le workspaceId est l'`id` côté staminads (cf provision-tenant qui le
   * retourne dans `staminadsWorkspaceId`).
   *
   * Algo & pondération : voir `src/score.ts`. Pour V1 :
   *   - pageviews + forms lus depuis staminads.analytics.query (30j)
   *   - calls / gsc / ads / pagespeed = 0 (TODO marqué côté score.ts)
   *
   * Erreurs :
   *   - 401/403 : auth (cf requireVeridianAdmin)
   *   - 400     : workspaceId vide
   *   - 404     : workspace introuvable côté staminads
   *   - 502     : staminads down ou réponse inattendue
   */
  app.get(
    "/api/admin/tenant/:workspaceId/score",
    requireVeridianAdmin,
    async (req, res) => {
      // Express 5 type Params : string | string[]. Sur une route :workspaceId
      // simple on n'a jamais un array, mais TS l'exige.
      const rawId = req.params.workspaceId;
      const workspaceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!workspaceId || workspaceId.length === 0) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }

      try {
        // Contrat natif : une query = UNE table.
        //   - pageviews = métrique `page_count` (count() sur table `pages`).
        //     ⚠️ PAS la métrique `pageviews` : son SQL countIf(name='screen_view')
        //     référence une colonne `name` absente des tables analytiques → casse
        //     ClickHouse. `page_count` est la vraie métrique câblée (1 ligne
        //     `pages` = 1 pageview), sémantiquement = l'ancien legacy screen_view.
        //   - goals = métrique `goals` (count() sur table `goals`).
        // On ne peut pas mélanger 2 tables dans une query → 2 queries M2M, puis
        // fusion pour `buildCountsFromStaminadsRows` (qui lit row.pageviews /
        // row.goals — on mappe page_count → pageviews avant de la passer).
        let pageviewRows: Array<Record<string, unknown>>;
        let goalRows: Array<Record<string, unknown>>;
        try {
          const [pvRes, goalRes] = await Promise.all([
            engineM2m.analyticsQuery({
              workspace_id: workspaceId,
              metrics: ["page_count"],
              dimensions: [],
              dateRange: { preset: "previous_30_days" },
              table: "pages",
            }),
            engineM2m.analyticsQuery({
              metrics: ["goals"], // proxy "form_submission" en attendant table bridge B1
              workspace_id: workspaceId,
              dimensions: [],
              dateRange: { preset: "previous_30_days" },
              table: "goals",
            }),
          ]);
          // Mappe page_count → pageviews pour rester compatible avec
          // buildCountsFromStaminadsRows (clé `pageviews`).
          pageviewRows = (pvRes.data ?? []).map((row) => ({
            pageviews: row["page_count"],
          }));
          goalRows = goalRes.data ?? [];
        } catch (err) {
          // 400/404 natif (workspace inconnu) → 404 propre ; sinon 502.
          const status =
            err instanceof EngineM2mError ? err.status : undefined;
          if (status === 404 || status === 400) {
            res
              .status(404)
              .json({ error: "workspace_not_found", workspaceId });
            return;
          }
          res.status(502).json({
            error: "analytics_query_failed",
            status: status ?? 500,
            body: err instanceof EngineM2mError ? err.body : String(err),
          });
          return;
        }

        const counts = buildCountsFromStaminadsRows([
          ...pageviewRows,
          ...goalRows,
        ]);
        const result = computeScore(counts);

        res.json({
          workspaceId,
          score: result.score,
          label: result.label,
          services: result.services,
        });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  app.get("/api/admin/analytics", requireVeridianAdmin, async (req, res) => {
    const wsId = req.query.wsId;
    if (typeof wsId !== "string" || wsId.length === 0) {
      res.status(400).json({ error: "missing_wsId" });
      return;
    }
    try {
      // Breakdown sessions par source d'acquisition (debug/affichage). Métrique
      // `sessions` (count() sur table `sessions`, câblée dans le query-builder)
      // ventilée par `utm_source` (dimension valide sur `sessions`). Preset
      // natif `today` (≈ l'ancien `last_24_hours`). On NE demande PAS la
      // métrique `pageviews` ici : son SQL countIf(name='screen_view') casse
      // (colonne `name` absente des tables analytiques) — le total pageviews
      // se lit via page_count/table pages (cf score/tenant-status).
      const result = await engineM2m.analyticsQuery({
        workspace_id: wsId,
        metrics: ["sessions"],
        dimensions: ["utm_source"],
        dateRange: { preset: "today" },
        table: "sessions",
      });
      res.json(result);
    } catch (err) {
      if (err instanceof EngineM2mError) {
        res.status(502).json({
          error: "analytics_query_failed",
          status: err.status,
          body: err.body,
        });
        return;
      }
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  });

  /**
   * GET /api/admin/tenant/:workspaceId/status
   *
   * Renvoie l'état des services Veridian (actifs / inactifs) pour un
   * workspace staminads. Le `workspaceId` est l'id staminads (retourné par
   * provision-tenant dans `staminadsWorkspaceId`).
   *
   * V1 (sprint A2) :
   *   - `pageviews` : query staminads.analytics (30j)
   *   - `forms` / `calls` / `gsc` / `ads` / `pagespeed` : 0, inactifs avec
   *     TODO marqués dans `src/tenant-status.ts` (B1 forms, A4 gsc, etc.)
   *
   * Erreurs :
   *   - 401/403 : auth (cf requireVeridianAdmin)
   *   - 400     : workspaceId vide / manquant
   *   - 500     : exception inattendue
   */
  const tenantStatusBuilder = createTenantStatusBuilder({
    fetchPageviews30d:
      opts.pageviewsFetcher ??
      makeStaminadsPageviewsFetcher({ engine: engineM2m }),
  });

  app.get(
    "/api/admin/tenant/:workspaceId/status",
    requireVeridianAdmin,
    async (req, res) => {
      const rawId = req.params.workspaceId;
      // express 5 type Params : string | string[]. Sur une route avec un
      // simple :workspaceId, on n'a jamais un array, mais TS l'exige.
      const workspaceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!workspaceId || workspaceId.length === 0) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      try {
        const status = await tenantStatusBuilder.build(workspaceId);
        res.json(status);
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  /**
   * GET /api/admin/tenant/:workspaceId/check-tracker
   *
   * Endpoint de l'onboarding wizard `/welcome` (U4 / ex-C3). Le wizard poll
   * cet endpoint toutes les 5s pendant que le nouveau tenant colle le snippet
   * sur son site, pour détecter le premier pageview reçu.
   *
   * Réponse : { status: 'ok'|'waiting', firstSeenAt: string|null, totalEvents24h }
   *
   * Erreurs :
   *   - 401/403 : auth (cf requireVeridianAdmin)
   *   - 400     : workspaceId vide / manquant
   *   - 500     : exception inattendue
   *
   * Un workspace inconnu ou vide n'est PAS une erreur : staminads renvoie 0
   * pageview → on répond 200 `{ status: 'waiting' }`. C'est l'état nominal
   * d'un site qui n'a pas encore posé le tracker.
   */
  const checkTrackerHandler = createCheckTrackerHandler({
    fetchRecentActivity:
      opts.recentActivityFetcher ??
      makeStaminadsRecentActivityFetcher({ engine: engineM2m }),
  });

  app.get(
    "/api/admin/tenant/:workspaceId/check-tracker",
    requireVeridianAdmin,
    checkTrackerHandler,
  );

  /**
   * GET /api/admin/shadow-marketing
   *
   * Renvoie la config statique de shadow marketing (textes vendeurs +
   * CTA + email pré-rempli) pour les 6 services de `KNOWN_SERVICES`.
   *
   * **PUBLIC** : pas d'auth. C'est du data statique marketing destiné au
   * front qui rend les blocks "service non actif comme pub passive" en
   * croisant avec `inactiveServices` du tenant-status.
   *
   * Le `emailBodyTemplate` contient un placeholder `{{domain}}` que le
   * front remplace par le domaine du site client au moment de construire
   * le mailto.
   */
  app.get("/api/admin/shadow-marketing", (_req, res) => {
    res.json(SHADOW_MARKETING);
  });

  // ─── Hub HMAC routes (B3) ──────────────────────────────────────────────
  //
  // Ces routes vivent SOUS leur propre middleware HMAC qui parse lui-même
  // le raw body (nécessaire pour la vérif de signature). On les monte en
  // dehors du `express.json()` global.

  const hubStore: TenantStore = cfg.hub?.store ?? new InMemoryTenantStore();
  const hubSecret = cfg.hub?.hmacSecret ?? "dev-secret-do-not-use";
  const hubSkip = cfg.hub?.skipHmac ?? false;

  const hubHmac = hubHmacMiddleware({
    secret: hubSecret,
    skipHmac: hubSkip,
  });

  // Default Engine hook (M2M natif) : provisionne workspace + apiKey.
  // Idempotent — cf. ProvisionDeps.createStaminadsWorkspace :
  //   - Cas A (nouveau)    → tenants.provision (crée workspace+user+apiKey).
  //   - Cas B (ré-attach)  → workspaces.provisionApiKey sur le workspace
  //     existant (régénère juste la key, pas de 409 email_already_exists).
  const defaultStaminadsHook = async (input: {
    hubTenantId: string;
    workspaceName: string;
    ownerEmail: string;
    existingWorkspaceId?: string;
  }) => {
    // Cas B : ré-attach → régénère une apiKey sur le workspace existant.
    if (input.existingWorkspaceId) {
      const result = await engineM2m.provisionApiKey({
        workspace_id: input.existingWorkspaceId,
        name: `veridian-hub-${input.hubTenantId}`,
        role: "admin",
      });
      return { workspaceId: result.workspace_id, apiKey: result.api_key };
    }

    // Cas A : nouveau tenant → provision complet (le natif slugifie name→id).
    const result = await engineM2m.provisionTenant({
      email: input.ownerEmail,
      name: input.workspaceName,
      siteUrl: `https://${input.workspaceName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "tenant"}.veridian.site`,
    });
    return { workspaceId: result.workspace_id, apiKey: result.api_key };
  };

  app.post(
    "/api/tenants/provision",
    hubHmac,
    provisionHandler({
      store: hubStore,
      createStaminadsWorkspace:
        cfg.hub?.createStaminadsWorkspace ?? defaultStaminadsHook,
      publicDashboardUrl: cfg.hub?.publicDashboardUrl,
    })
  );

  app.post(
    "/api/tenants/attach-owner",
    hubHmac,
    attachOwnerHandler({ store: hubStore })
  );

  app.get(
    "/api/tenants/:id/health",
    hubHmac,
    healthHandler({ store: hubStore, loadStats: cfg.hub?.loadStats })
  );

  return app;
}
