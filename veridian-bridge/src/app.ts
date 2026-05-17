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

export interface BridgeConfig {
  staminadsUrl: string;
  adminEmail: string;
  adminPassword: string;
  veridianAdminApiKey: string;
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

export function createApp(cfg: BridgeConfig): Express {
  validateConfig(cfg);

  const app = express();
  app.use(express.json({ limit: "256kb" }));

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

      const wsRes = await fetch(`${cfg.staminadsUrl}/api/workspaces.create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
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
          workspaceId: ws.id,
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
          endpoint: cfg.staminadsUrl,
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
          workspaceId: wsId,
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

  return app;
}
