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

export interface BridgeConfig {
  staminadsUrl: string;
  /**
   * URL publique de staminads à coller dans le snippet tracker côté sites clients.
   * Optionnel : si absent, fallback sur staminadsUrl (utile en dev local).
   * Ex en staging : https://analytics-engine.staging.veridian.site
   */
  publicStaminadsUrl?: string;
  adminEmail: string;
  adminPassword: string;
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

export interface AdminToken {
  token: string;
  expiresAt: number;
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
  if (!cfg.adminEmail.includes("@")) {
    throw new Error("adminEmail invalid");
  }
  if (!cfg.adminPassword || cfg.adminPassword.length < 8) {
    throw new Error("adminPassword too short (need >= 8 chars)");
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

  let cachedAdminToken: AdminToken | null = null;

  async function getAdminToken(): Promise<string> {
    if (cachedAdminToken && cachedAdminToken.expiresAt > Date.now() + 60_000) {
      return cachedAdminToken.token;
    }

    const setupRes = await fetch(`${cfg.staminadsUrl}/api/setup.status`);
    if (!setupRes.ok) {
      throw new Error(`setup.status failed: ${setupRes.status}`);
    }
    const setupBody = (await setupRes.json()) as { setupCompleted: boolean };

    if (!setupBody.setupCompleted) {
      const initRes = await fetch(`${cfg.staminadsUrl}/api/setup.initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cfg.adminEmail,
          password: cfg.adminPassword,
          name: "Veridian Admin",
        }),
      });
      if (!initRes.ok) {
        const text = await initRes.text();
        throw new Error(`setup.initialize failed: ${initRes.status} ${text}`);
      }
      const initBody = (await initRes.json()) as { access_token: string };
      cachedAdminToken = {
        token: initBody.access_token,
        expiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
      };
      return cachedAdminToken.token;
    }

    const loginRes = await fetch(`${cfg.staminadsUrl}/api/auth.login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.adminEmail, password: cfg.adminPassword }),
    });
    if (!loginRes.ok) {
      const text = await loginRes.text();
      throw new Error(`auth.login failed: ${loginRes.status} ${text}`);
    }
    const loginBody = (await loginRes.json()) as { access_token: string };
    cachedAdminToken = {
      token: loginBody.access_token,
      expiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
    };
    return cachedAdminToken.token;
  }

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
      const adminToken = await getAdminToken();

      // staminads id : [a-z][a-z0-9_]*, 2-50 chars (cf workspaces.create DTO).
      // On transforme le tenantSlug Veridian (qui autorise les tirets) en id
      // staminads valide. Tirets → underscores, lowercase forcé.
      const staminadsWorkspaceId = parsed.data.tenantSlug
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^[^a-z]/, "v_$&")
        .slice(0, 50);

      const wsRes = await fetch(`${cfg.staminadsUrl}/api/workspaces.create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          id: staminadsWorkspaceId,
          name: parsed.data.tenantName,
          website: parsed.data.website,
          timezone: parsed.data.timezone,
          currency: parsed.data.currency,
        }),
      });
      if (!wsRes.ok) {
        const text = await wsRes.text();
        res
          .status(502)
          .json({ error: "workspace_create_failed", status: wsRes.status, body: text });
        return;
      }
      const ws = (await wsRes.json()) as { id: string; name: string };

      const keyRes = await fetch(`${cfg.staminadsUrl}/api/apiKeys.create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          // staminads attend snake_case (vérifié sur l'API en staging, DTO `workspace_id`)
          workspace_id: ws.id,
          name: `veridian-tenant-${parsed.data.tenantSlug}`,
          role: "admin",
        }),
      });
      if (!keyRes.ok) {
        const text = await keyRes.text();
        res.status(502).json({
          error: "apikey_create_failed",
          status: keyRes.status,
          body: text,
        });
        return;
      }
      const apiKey = (await keyRes.json()) as { key: string; id: string };

      res.json({
        tenantSlug: parsed.data.tenantSlug,
        staminadsWorkspaceId: ws.id,
        staminadsApiKey: apiKey.key,
        trackingSnippet: {
          workspaceId: ws.id,
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
      const workspaceId = req.params.workspaceId;
      if (!workspaceId || workspaceId.length === 0) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }

      try {
        const adminToken = await getAdminToken();
        const queryRes = await fetch(
          `${cfg.staminadsUrl}/api/analytics.query`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              workspace_id: workspaceId,
              // Métriques utilisées par V1 du score :
              //   - pageviews : ingestion tracker
              //   - goals     : proxy "form_submission" en attendant table bridge B1
              metrics: ["pageviews", "goals"],
              dimensions: [],
              dateRange: { type: "last_30_days" },
            }),
          },
        );

        // staminads renvoie 404 ou 400 si le workspace n'existe pas ou n'est
        // pas accessible — on traduit en 404 propre côté bridge.
        if (queryRes.status === 404 || queryRes.status === 400) {
          res.status(404).json({ error: "workspace_not_found", workspaceId });
          return;
        }
        if (!queryRes.ok) {
          const text = await queryRes.text();
          res.status(502).json({
            error: "analytics_query_failed",
            status: queryRes.status,
            body: text,
          });
          return;
        }

        const queryBody = (await queryRes.json()) as {
          rows?: Array<Record<string, unknown>>;
        };
        const rows = Array.isArray(queryBody.rows) ? queryBody.rows : [];
        const counts = buildCountsFromStaminadsRows(rows);
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
      const adminToken = await getAdminToken();
      const queryRes = await fetch(`${cfg.staminadsUrl}/api/analytics.query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          // staminads DTO mixte : workspace_id snake_case, dateRange camelCase
          workspace_id: wsId,
          metrics: ["pageviews", "sessions"],
          dimensions: ["utm_source"],
          dateRange: { type: "last_24_hours" },
        }),
      });
      const body = await queryRes.text();
      res.status(queryRes.status).type("application/json").send(body);
    } catch (err) {
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
      makeStaminadsPageviewsFetcher({
        staminadsUrl: cfg.staminadsUrl,
        getAdminToken,
      }),
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
      makeStaminadsRecentActivityFetcher({
        staminadsUrl: cfg.staminadsUrl,
        getAdminToken,
      }),
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

  // Default staminads hook : appelle l'API workspaces.create / apiKeys.create
  // via le pipeline admin token déjà existant.
  const defaultStaminadsHook = async (input: {
    hubTenantId: string;
    workspaceName: string;
    ownerEmail: string;
  }) => {
    const adminToken = await getAdminToken();
    const wsId = input.hubTenantId
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^[^a-z]/, "v_$&")
      .slice(0, 50);
    const wsRes = await fetch(`${cfg.staminadsUrl}/api/workspaces.create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        id: wsId,
        name: input.workspaceName,
        website: `https://${wsId}.veridian.site`,
        timezone: "UTC",
        currency: "EUR",
      }),
    });
    if (!wsRes.ok) {
      throw new Error(`workspace_create_failed:${wsRes.status}`);
    }
    const ws = (await wsRes.json()) as { id: string };

    const keyRes = await fetch(`${cfg.staminadsUrl}/api/apiKeys.create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        workspace_id: ws.id,
        name: `veridian-hub-${input.hubTenantId}`,
        role: "admin",
      }),
    });
    if (!keyRes.ok) {
      throw new Error(`apikey_create_failed:${keyRes.status}`);
    }
    const apiKey = (await keyRes.json()) as { key: string };
    return { workspaceId: ws.id, apiKey: apiKey.key };
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
