/**
 * B1 — Test happy path : POST /api/ingest/form → FormSubmission + Lead + event staminads.
 *
 * Démarre un Express avec `registerFormsRoutes()` connecté à un FakePrismaClient.
 * Mock fetch pour staminads. Vérifie :
 *   1. Réponse 200 + submissionId
 *   2. FormSubmission créé en DB
 *   3. Lead créé (email présent)
 *   4. LeadSession créée
 *   5. Event staminads pushé avec lead_id custom dim
 *   6. FormSchema auto-créé
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { registerFormsRoutes } from "../../src/forms/index.js";
import { FakePrismaClientWithForms } from "../helpers/fake-prisma-forms.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

interface Started {
  url: string;
  close: () => Promise<void>;
  staminadsCalls: Array<{ url: string; body: unknown }>;
}

async function startApp(
  prisma: FakePrismaClientWithForms,
): Promise<Started> {
  const staminadsCalls: Array<{ url: string; body: unknown }> = [];

  const fakeFetch: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = input instanceof URL ? input.toString() : String(input);
    staminadsCalls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  registerFormsRoutes(app, {
    prisma: prisma as unknown as PrismaClient,
    requireAdmin: (_req, _res, next) => next(),
    staminadsUrl: "http://fake-staminads",
    fetchImpl: fakeFetch,
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
        staminadsCalls,
      });
    });
  });
}

let app: Started | null = null;
let prisma: FakePrismaClientWithForms;

beforeEach(async () => {
  prisma = new FakePrismaClientWithForms();
  // Seed : 1 tenant + 1 site
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
      siteKey: "sk_test_pub_123",
      domain: "test.com",
      name: "Test Site",
    },
  });
  app = await startApp(prisma);
});

afterEach(async () => {
  if (app) await app.close();
});

test("happy path : POST form → submission + lead + event staminads", async () => {
  const res = await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "sk_test_pub_123",
      formSlug: "contact-devis",
      formName: "Demande de devis",
      data: {
        email: "client@example.com",
        name: "Jean Dupont",
        message: "Bonjour, je voudrais un devis pour 100 unites",
      },
      visitorId: "vrd_abc123",
      sessionId: "sess_xyz",
      pageUrl: "https://test.com/contact",
      utm: { source: "google", medium: "cpc", campaign: "summer" },
    }),
  });

  assert.equal(res.status, 200, "status 200");
  const body = (await res.json()) as {
    ok: boolean;
    submissionId: string;
    leadId: string | null;
    leadCreated: boolean;
  };
  assert.equal(body.ok, true);
  assert.ok(body.submissionId, "submissionId présent");
  assert.ok(body.leadId, "leadId présent (email valide)");
  assert.equal(body.leadCreated, true, "lead créé (premier POST)");

  // DB checks
  assert.equal(prisma.formSubmissions.length, 1, "1 FormSubmission");
  assert.equal(prisma.leads.length, 1, "1 Lead");
  assert.equal(prisma.leadSessions.length, 1, "1 LeadSession");
  assert.equal(prisma.formSchemas.length, 1, "1 FormSchema auto-créé");

  const sub = prisma.formSubmissions[0];
  assert.equal(sub.siteId, "site1");
  assert.equal(sub.formSlug, "contact-devis");
  assert.equal(sub.leadId, body.leadId);
  assert.equal(sub.visitorId, "vrd_abc123");
  assert.equal(sub.pageUrl, "https://test.com/contact");

  const lead = prisma.leads[0];
  assert.equal(lead.email, "client@example.com");
  assert.equal(lead.name, "Jean Dupont");
  assert.equal(lead.submissionsCount, 1);

  const session = prisma.leadSessions[0];
  assert.equal(session.leadId, lead.id);
  assert.equal(session.visitorId, "vrd_abc123");
  assert.equal(session.source, "google");
  assert.equal(session.medium, "cpc");
  assert.equal(session.campaign, "summer");

  const schema = prisma.formSchemas[0];
  assert.equal(schema.formSlug, "contact-devis");
  assert.equal(schema.name, "Demande de devis");

  // Staminads event pushé
  assert.equal(app!.staminadsCalls.length, 1, "1 staminads call");
  const call = app!.staminadsCalls[0];
  assert.match(call.url, /\/api\/track$/);
  const payload = call.body as {
    workspace_id: string;
    actions: Array<{ type: string; name: string }>;
    attributes: { lead_id: string; form_slug: string };
  };
  assert.equal(payload.workspace_id, "ws_test");
  assert.equal(payload.actions[0].name, "form_submission");
  assert.equal(payload.attributes.lead_id, lead.id);
  assert.equal(payload.attributes.form_slug, "contact-devis");
});

test("POST sans email → submission créée, leadId null", async () => {
  const res = await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "sk_test_pub_123",
      formSlug: "newsletter",
      data: { subscribe: true },
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { leadId: string | null };
  assert.equal(body.leadId, null);
  assert.equal(prisma.formSubmissions.length, 1);
  assert.equal(prisma.leads.length, 0);
});
