/**
 * B1 — Test dedup : 2 POST avec même email → 1 Lead avec submissionsCount=2.
 *
 * Vérifie la logique upsert Lead par (siteId, email).
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
      siteKey: "sk_dedup",
      domain: "test.com",
      name: "Test Site",
    },
  });
  app = await startApp(prisma);
});

afterEach(async () => {
  if (app) await app.close();
});

test("2 POST même email → 1 Lead, submissionsCount=2", async () => {
  const post = (email: string, msg: string) =>
    fetch(`${app!.url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteKey: "sk_dedup",
        formSlug: "contact",
        data: { email, message: msg },
      }),
    });

  const r1 = await post("anna@example.com", "premier message");
  const b1 = (await r1.json()) as { leadId: string; leadCreated: boolean };
  assert.equal(r1.status, 200);
  assert.equal(b1.leadCreated, true);

  const r2 = await post("anna@example.com", "second message");
  const b2 = (await r2.json()) as { leadId: string; leadCreated: boolean };
  assert.equal(r2.status, 200);
  assert.equal(b2.leadCreated, false, "second POST n'a pas créé de Lead");
  assert.equal(b1.leadId, b2.leadId, "même leadId pour les 2 soumissions");

  assert.equal(prisma.leads.length, 1, "1 seul Lead en DB");
  assert.equal(prisma.leads[0].submissionsCount, 2, "submissionsCount = 2");
  assert.equal(prisma.formSubmissions.length, 2, "2 FormSubmissions");
});

test("dedup case-insensitive sur email", async () => {
  // L'email est normalisé en lowercase par extractLeadFields()
  await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "sk_dedup",
      formSlug: "contact",
      data: { email: "Anna@Example.com", name: "Anna" },
    }),
  });
  await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "sk_dedup",
      formSlug: "contact",
      data: { email: "anna@example.com", name: "Anna B" },
    }),
  });
  assert.equal(prisma.leads.length, 1, "case-insensitive dedup");
  assert.equal(prisma.leads[0].email, "anna@example.com");
  assert.equal(prisma.leads[0].submissionsCount, 2);
});

test("2 emails différents → 2 Leads", async () => {
  for (const email of ["a@x.com", "b@x.com"]) {
    await fetch(`${app!.url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteKey: "sk_dedup",
        formSlug: "contact",
        data: { email },
      }),
    });
  }
  assert.equal(prisma.leads.length, 2);
});
