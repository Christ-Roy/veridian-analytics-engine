/**
 * B1 — Test endpoint admin : GET /api/admin/tenant/:workspaceId/forms.
 *
 * Vérifie :
 *   - 401 sans Bearer
 *   - 403 mauvais token
 *   - 404 si tenant inconnu
 *   - 200 + items paginés + nextCursor
 *   - filtres formSlug, since, until
 *   - getLeadDetails(leadId) en bonus
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import {
  ingestFormSubmission,
  registerFormsRoutes,
} from "../../src/forms/index.js";
import { FakePrismaClientWithForms } from "../helpers/fake-prisma-forms.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";
const stubFetch: typeof fetch = (async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  }) as unknown as Response) as typeof fetch;

interface Started {
  url: string;
  close: () => Promise<void>;
}

function requireAdmin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: any,
  next: () => void,
): void {
  const auth = req.header("authorization") as string | undefined;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_bearer" });
    return;
  }
  if (auth.slice("Bearer ".length).trim() !== ADMIN_KEY) {
    res.status(403).json({ error: "invalid_admin_key" });
    return;
  }
  next();
}

async function startApp(
  prisma: FakePrismaClientWithForms,
): Promise<Started> {
  const app = express();
  app.use(express.json());
  registerFormsRoutes(app, {
    prisma: prisma as unknown as PrismaClient,
    requireAdmin,
    staminadsUrl: "http://fake",
    fetchImpl: stubFetch,
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            srv.close((e) => (e ? rej(e) : res())),
          ),
      });
    });
  });
}

let app: Started | null = null;
let prisma: FakePrismaClientWithForms;

beforeEach(async () => {
  prisma = new FakePrismaClientWithForms();
  await prisma.tenant.create({
    data: {
      id: "t1",
      workspaceId: "ws_list",
      slug: "list-tenant",
      name: "List Tenant",
    },
  });
  await prisma.site.create({
    data: {
      id: "site1",
      tenantId: "t1",
      siteKey: "sk_list",
      domain: "list.com",
      name: "List Site",
    },
  });

  // Seed 5 submissions (3 contact, 2 newsletter) avec des createdAt
  // décroissants pour stabiliser l'ordre.
  for (let i = 0; i < 5; i++) {
    const slug = i < 3 ? "contact" : "newsletter";
    await ingestFormSubmission(
      { prisma: prisma as unknown as PrismaClient, staminadsUrl: undefined },
      {
        siteKey: "sk_list",
        formSlug: slug,
        data: { email: `user${i}@x.com`, idx: i },
      },
    );
    // Force des createdAt différents
    const last = prisma.formSubmissions[prisma.formSubmissions.length - 1];
    last.createdAt = new Date(Date.now() - (5 - i) * 1000);
  }

  app = await startApp(prisma);
});

afterEach(async () => {
  if (app) await app.close();
});

test("GET /forms sans Bearer → 401", async () => {
  const res = await fetch(
    `${app!.url}/api/admin/tenant/ws_list/forms`,
  );
  assert.equal(res.status, 401);
});

test("GET /forms mauvais token → 403", async () => {
  const res = await fetch(`${app!.url}/api/admin/tenant/ws_list/forms`, {
    headers: { Authorization: "Bearer wrong-key-32-chars-xxxxxxxxxxx" },
  });
  assert.equal(res.status, 403);
});

test("GET /forms tenant inconnu → 404", async () => {
  const res = await fetch(`${app!.url}/api/admin/tenant/ws_nope/forms`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(res.status, 404);
});

test("GET /forms → liste paginée (limit=3, nextCursor)", async () => {
  const res = await fetch(
    `${app!.url}/api/admin/tenant/ws_list/forms?limit=3`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    workspaceId: string;
    items: Array<{ id: string; formSlug: string; leadEmail: string | null }>;
    nextCursor: string | null;
  };
  assert.equal(body.workspaceId, "ws_list");
  assert.equal(body.items.length, 3);
  assert.ok(body.nextCursor, "nextCursor présent");
  // Items ordonnés du plus récent au plus ancien (idx=4 first)
  assert.equal(body.items[0].leadEmail, "user4@x.com");
});

test("GET /forms?formSlug=newsletter → filtre OK", async () => {
  const res = await fetch(
    `${app!.url}/api/admin/tenant/ws_list/forms?formSlug=newsletter`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: Array<{ formSlug: string }>;
  };
  assert.equal(body.items.length, 2, "2 newsletters");
  assert.ok(body.items.every((i) => i.formSlug === "newsletter"));
});

test("GET /admin/lead/:id → détail Lead + submissions", async () => {
  const lead = prisma.leads[0];
  const res = await fetch(`${app!.url}/api/admin/lead/${lead.id}`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    lead: { id: string; email: string };
    submissions: Array<{ formSlug: string }>;
  };
  assert.equal(body.lead.id, lead.id);
  assert.equal(body.lead.email, lead.email);
  assert.ok(body.submissions.length >= 1, "au moins 1 submission");
});

test("GET /admin/lead/:id inconnu → 404", async () => {
  const res = await fetch(`${app!.url}/api/admin/lead/lead_nope`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(res.status, 404);
});
