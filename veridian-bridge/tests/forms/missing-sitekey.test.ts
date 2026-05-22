/**
 * B1 — Test : siteKey invalide / manquant → 401, body invalide → 400.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { registerFormsRoutes } from "../../src/forms/index.js";
import { FakePrismaClientWithForms } from "../helpers/fake-prisma-forms.js";

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

async function startApp(prisma: FakePrismaClientWithForms): Promise<Started> {
  const app = express();
  app.use(express.json());
  registerFormsRoutes(app, {
    prisma: prisma as unknown as PrismaClient,
    requireAdmin: (_req, _res, next) => next(),
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
      workspaceId: "ws_test",
      slug: "test-tenant",
      name: "Test Tenant",
    },
  });
  await prisma.site.create({
    data: {
      id: "site1",
      tenantId: "t1",
      siteKey: "sk_valid",
      domain: "test.com",
      name: "Test Site",
    },
  });
  app = await startApp(prisma);
});

afterEach(async () => {
  if (app) await app.close();
});

test("siteKey inconnu → 401 invalid_site_key", async () => {
  const res = await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "sk_does_not_exist",
      formSlug: "contact",
      data: { email: "a@b.com" },
    }),
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_site_key");
  assert.equal(prisma.formSubmissions.length, 0, "rien créé en DB");
});

test("payload manquant siteKey → 400 invalid_body", async () => {
  const res = await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ formSlug: "contact", data: {} }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_body");
});

test("payload manquant formSlug → 400", async () => {
  const res = await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: "sk_valid", data: {} }),
  });
  assert.equal(res.status, 400);
});

test("tenant soft-deleted → 401 invalid_site_key", async () => {
  // soft-delete le tenant
  prisma.tenants[0].softDeletedAt = new Date();
  const res = await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "sk_valid",
      formSlug: "contact",
      data: { email: "a@b.com" },
    }),
  });
  assert.equal(res.status, 401);
  assert.equal(prisma.formSubmissions.length, 0);
});
