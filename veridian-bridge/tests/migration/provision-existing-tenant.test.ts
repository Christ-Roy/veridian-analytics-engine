/**
 * Tests de l'endpoint POST /api/admin/provision-existing-tenant (D2).
 *
 * Couvre `src/admin/provision-existing-tenant.ts` :
 *   - logique métier `provisionExistingTenant` (idempotence ++)
 *   - helpers purs `toStaminadsWorkspaceId` / `buildTrackerSnippet`
 *   - handler HTTP via une mini-app Express (validation Zod, codes 201/200/400)
 *
 * Fake Prisma in-memory minimal (site + tenant) — pas de vraie DB en local.
 * Le test d'intégration RÉEL (vrai Postgres) sera porté par l'agent T*.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";
import {
  provisionExistingTenant,
  provisionExistingTenantHandler,
  toStaminadsWorkspaceId,
  buildTrackerSnippet,
  type ProvisionExistingDeps,
} from "../../src/admin/provision-existing-tenant.js";

// ─── Fake Prisma minimal ────────────────────────────────────────────────────

interface FakeTenantRow {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  plan: string;
  planSource: string | null;
  status: string;
  apiKey: string | null;
}

interface FakeSiteRow {
  id: string;
  tenantId: string;
  siteKey: string;
  domain: string;
  name: string;
}

class FakeMigrationPrisma {
  tenants: FakeTenantRow[] = [];
  sites: FakeSiteRow[] = [];
  private seq = 0;

  tenant = {
    findUnique: async (args: {
      where: { slug?: string; id?: string };
    }): Promise<FakeTenantRow | null> => {
      return (
        this.tenants.find(
          (t) =>
            (args.where.slug && t.slug === args.where.slug) ||
            (args.where.id && t.id === args.where.id),
        ) ?? null
      );
    },
    create: async (args: {
      data: Partial<FakeTenantRow> & {
        workspaceId: string;
        slug: string;
        name: string;
      };
    }): Promise<FakeTenantRow> => {
      // Émule la contrainte @@unique sur slug + workspaceId.
      if (this.tenants.some((t) => t.slug === args.data.slug)) {
        throw new Error("Unique constraint failed: slug");
      }
      if (this.tenants.some((t) => t.workspaceId === args.data.workspaceId)) {
        throw new Error("Unique constraint failed: workspaceId");
      }
      const t: FakeTenantRow = {
        id: `tnt_${++this.seq}`,
        workspaceId: args.data.workspaceId,
        slug: args.data.slug,
        name: args.data.name,
        plan: args.data.plan ?? "free",
        planSource: args.data.planSource ?? null,
        status: args.data.status ?? "active",
        apiKey: args.data.apiKey ?? null,
      };
      this.tenants.push(t);
      return t;
    },
  };

  site = {
    findUnique: async (args: {
      where: { siteKey: string };
      include?: { tenant?: boolean };
    }): Promise<(FakeSiteRow & { tenant?: FakeTenantRow }) | null> => {
      const s = this.sites.find((x) => x.siteKey === args.where.siteKey);
      if (!s) return null;
      if (args.include?.tenant) {
        const tenant = this.tenants.find((t) => t.id === s.tenantId);
        if (!tenant) throw new Error(`tenant ${s.tenantId} missing`);
        return { ...s, tenant };
      }
      return s;
    },
    create: async (args: {
      data: { tenantId: string; siteKey: string; domain: string; name: string };
    }): Promise<FakeSiteRow> => {
      // Émule la contrainte @@unique sur siteKey.
      if (this.sites.some((s) => s.siteKey === args.data.siteKey)) {
        throw new Error("Unique constraint failed: siteKey");
      }
      const s: FakeSiteRow = {
        id: `site_${++this.seq}`,
        tenantId: args.data.tenantId,
        siteKey: args.data.siteKey,
        domain: args.data.domain,
        name: args.data.name,
      };
      this.sites.push(s);
      return s;
    },
  };
}

/** Construit des deps avec un hook staminads qui compte ses appels. */
function makeDeps(prisma: FakeMigrationPrisma): {
  deps: ProvisionExistingDeps;
  staminadsCalls: Array<{ workspaceId: string; domain: string }>;
} {
  const staminadsCalls: Array<{ workspaceId: string; domain: string }> = [];
  const deps: ProvisionExistingDeps = {
    prisma: prisma as unknown as PrismaClient,
    publicStaminadsUrl: "https://analytics-engine.app.veridian.site",
    publicDashboardUrl: "https://analytics.app.veridian.site",
    createStaminadsWorkspace: async (input) => {
      staminadsCalls.push({
        workspaceId: input.workspaceId,
        domain: input.domain,
      });
      return {
        workspaceId: input.workspaceId,
        apiKey: `sk_fake_${input.workspaceId}`,
      };
    },
  };
  return { deps, staminadsCalls };
}

// ─── toStaminadsWorkspaceId ─────────────────────────────────────────────────

test("toStaminadsWorkspaceId : tirets → underscores", () => {
  assert.equal(
    toStaminadsWorkspaceId("morel-volailles-com"),
    "morel_volailles_com",
  );
});

test("toStaminadsWorkspaceId : préfixe v_ si commence par non-lettre", () => {
  assert.match(toStaminadsWorkspaceId("3pommes"), /^v_/);
});

test("toStaminadsWorkspaceId : tronque à 50 chars", () => {
  assert.ok(toStaminadsWorkspaceId("a".repeat(80)).length <= 50);
});

// ─── buildTrackerSnippet ────────────────────────────────────────────────────

test("buildTrackerSnippet : embarque workspaceId + visitor-id", () => {
  const s = buildTrackerSnippet({
    workspaceId: "ws_1",
    endpoint: "https://engine.fr/",
    visitorIdEnabled: true,
  });
  assert.match(s, /data-workspace-id="ws_1"/);
  assert.match(s, /data-visitor-id="true"/);
  // slash final retiré.
  assert.equal(s.includes("engine.fr//"), false);
});

test("buildTrackerSnippet : visitorIdEnabled=false → pas d'attribut", () => {
  const s = buildTrackerSnippet({
    workspaceId: "w",
    endpoint: "https://x.fr",
    visitorIdEnabled: false,
  });
  assert.equal(/data-visitor-id/.test(s), false);
});

// ─── provisionExistingTenant — création ─────────────────────────────────────

test("provisionExistingTenant : nouveau site → créé + workspace staminads", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps, staminadsCalls } = makeDeps(prisma);

  const r = await provisionExistingTenant(deps, {
    siteKey: "sk_morel_legacy",
    slug: "morel-volailles-com",
    domain: "morel-volailles.com",
    visitorIdEnabled: true,
  });

  assert.equal(r.created, true);
  assert.equal(r.siteKey, "sk_morel_legacy");
  assert.equal(r.workspaceId, "morel_volailles_com");
  assert.equal(r.apiKey, "sk_fake_morel_volailles_com");
  assert.match(r.dashboardUrl, /^https:\/\//);
  assert.match(r.snippet, /data-workspace-id="morel_volailles_com"/);
  // 1 workspace staminads créé, 1 Tenant, 1 Site.
  assert.equal(staminadsCalls.length, 1);
  assert.equal(prisma.tenants.length, 1);
  assert.equal(prisma.sites.length, 1);
});

test("provisionExistingTenant : le siteKey legacy est RÉUTILISÉ tel quel", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps } = makeDeps(prisma);
  await provisionExistingTenant(deps, {
    siteKey: "sk_exact_legacy_value",
    slug: "x-client",
    domain: "x.fr",
    visitorIdEnabled: true,
  });
  // Le Site bridge doit porter EXACTEMENT le siteKey legacy (snippet stable).
  assert.equal(prisma.sites[0].siteKey, "sk_exact_legacy_value");
});

// ─── provisionExistingTenant — IDEMPOTENCE ──────────────────────────────────

test("provisionExistingTenant : rejouer → idempotent, created=false, 0 doublon", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps, staminadsCalls } = makeDeps(prisma);

  const first = await provisionExistingTenant(deps, {
    siteKey: "sk_idem",
    slug: "idem-client",
    domain: "idem.fr",
    visitorIdEnabled: true,
  });
  const second = await provisionExistingTenant(deps, {
    siteKey: "sk_idem",
    slug: "idem-client",
    domain: "idem.fr",
    visitorIdEnabled: true,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  // Mêmes identifiants renvoyés.
  assert.equal(second.tenantId, first.tenantId);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(second.siteId, first.siteId);
  // AUCUN doublon : 1 Tenant, 1 Site, 1 seul appel staminads.
  assert.equal(prisma.tenants.length, 1);
  assert.equal(prisma.sites.length, 1);
  assert.equal(staminadsCalls.length, 1);
});

test("provisionExistingTenant : 5 rejeux d'affilée restent idempotents", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps, staminadsCalls } = makeDeps(prisma);
  for (let i = 0; i < 5; i++) {
    await provisionExistingTenant(deps, {
      siteKey: "sk_5x",
      slug: "five-x",
      domain: "5x.fr",
      visitorIdEnabled: true,
    });
  }
  assert.equal(prisma.tenants.length, 1);
  assert.equal(prisma.sites.length, 1);
  assert.equal(staminadsCalls.length, 1);
});

test("provisionExistingTenant : Tenant déjà créé mais Site absent → réutilise le Tenant", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps, staminadsCalls } = makeDeps(prisma);
  // Simule un Tenant déjà provisionné (ex: provision-tenant) sans Site.
  prisma.tenants.push({
    id: "tnt_preexisting",
    workspaceId: "preexist_client",
    slug: "preexist-client",
    name: "Preexist",
    plan: "free",
    planSource: "hub",
    status: "active",
    apiKey: "sk_hub_key",
  });

  const r = await provisionExistingTenant(deps, {
    siteKey: "sk_preexist",
    slug: "preexist-client",
    domain: "preexist.fr",
    visitorIdEnabled: true,
  });

  assert.equal(r.created, true);
  assert.equal(r.tenantId, "tnt_preexisting");
  assert.equal(r.apiKey, "sk_hub_key");
  // Pas de nouveau workspace staminads — le Tenant existait déjà.
  assert.equal(staminadsCalls.length, 0);
  assert.equal(prisma.tenants.length, 1);
  assert.equal(prisma.sites.length, 1);
});

// ─── Handler HTTP ───────────────────────────────────────────────────────────

async function bootApp(deps: ProvisionExistingDeps): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.post(
    "/api/admin/provision-existing-tenant",
    provisionExistingTenantHandler(deps),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("handler : POST valide → 201 created", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps } = makeDeps(prisma);
  const app = await bootApp(deps);
  try {
    const res = await fetch(`${app.url}/api/admin/provision-existing-tenant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteKey: "sk_http_1",
        slug: "http-client",
        domain: "http.fr",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { created: boolean; workspaceId: string };
    assert.equal(body.created, true);
    assert.equal(body.workspaceId, "http_client");
  } finally {
    await app.close();
  }
});

test("handler : POST rejoué → 200 (pas 201), idempotent", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps } = makeDeps(prisma);
  const app = await bootApp(deps);
  try {
    const payload = JSON.stringify({
      siteKey: "sk_http_idem",
      slug: "http-idem",
      domain: "httpidem.fr",
    });
    const headers = { "Content-Type": "application/json" };
    const r1 = await fetch(`${app.url}/api/admin/provision-existing-tenant`, {
      method: "POST",
      headers,
      body: payload,
    });
    const r2 = await fetch(`${app.url}/api/admin/provision-existing-tenant`, {
      method: "POST",
      headers,
      body: payload,
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
  } finally {
    await app.close();
  }
});

test("handler : body invalide (siteKey manquant) → 400", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps } = makeDeps(prisma);
  const app = await bootApp(deps);
  try {
    const res = await fetch(`${app.url}/api/admin/provision-existing-tenant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "x", domain: "x.fr" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_body");
  } finally {
    await app.close();
  }
});

test("handler : visitorIdEnabled défaut true dans le snippet", async () => {
  const prisma = new FakeMigrationPrisma();
  const { deps } = makeDeps(prisma);
  const app = await bootApp(deps);
  try {
    const res = await fetch(`${app.url}/api/admin/provision-existing-tenant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteKey: "sk_default_vid",
        slug: "default-vid",
        domain: "dv.fr",
      }),
    });
    const body = (await res.json()) as { snippet: string };
    assert.match(body.snippet, /data-visitor-id="true"/);
  } finally {
    await app.close();
  }
});
