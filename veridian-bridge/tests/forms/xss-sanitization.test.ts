/**
 * B1 (bonus) — Test sanitization XSS : balises HTML, scripts, protocoles
 * dangereux. Le payload stocké en DB doit être nettoyé — pas de balises,
 * pas de `javascript:` ni `data:`.
 *
 * On NE teste PAS la non-exécution côté front (jsdom non utilisé ici).
 * On valide UNIQUEMENT que ce qui entre en `data` ressort propre.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { registerFormsRoutes } from "../../src/forms/index.js";
import {
  sanitizePayload,
  sanitizeString,
} from "../../src/forms/sanitize.js";
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
      workspaceId: "ws_xss",
      slug: "xss-tenant",
      name: "XSS Tenant",
    },
  });
  await prisma.site.create({
    data: {
      id: "site1",
      tenantId: "t1",
      siteKey: "sk_xss",
      domain: "xss.test",
      name: "XSS Site",
    },
  });
  app = await startApp(prisma);
});

afterEach(async () => {
  if (app) await app.close();
});

test("sanitizeString strippe balises HTML + scripts", () => {
  assert.equal(
    sanitizeString("<script>alert(1)</script>hello"),
    "alert(1)hello",
  );
  assert.equal(
    sanitizeString('<img src=x onerror="alert(1)">'),
    "",
  );
  assert.equal(sanitizeString("plain text"), "plain text");
  assert.equal(
    sanitizeString("nom: <b>Jean</b>"),
    "nom: Jean",
  );
});

test("sanitizeString blanchit javascript: et data:", () => {
  assert.match(sanitizeString("javascript:alert(1)"), /blocked:/i);
  assert.match(sanitizeString("DATA:text/html,<script>"), /blocked:/i);
});

test("sanitizePayload récursif sur object + array", () => {
  const dirty = {
    name: "<b>Jean</b>",
    nested: {
      url: "javascript:evil()",
      tags: ["<script>x</script>", "ok"],
    },
    n: 42,
    flag: true,
  };
  const clean = sanitizePayload(dirty) as Record<string, unknown>;
  assert.equal(clean.name, "Jean");
  assert.match(
    (clean.nested as { url: string }).url,
    /blocked:/i,
  );
  assert.deepEqual((clean.nested as { tags: string[] }).tags, ["x", "ok"]);
  assert.equal(clean.n, 42);
  assert.equal(clean.flag, true);
});

test("POST avec payload XSS → stocké sanitizé en DB", async () => {
  await fetch(`${app!.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "sk_xss",
      formSlug: "contact",
      data: {
        email: "evil@example.com",
        name: "<script>alert('pwned')</script>Mallory",
        message: '<a href="javascript:void(0)">click</a>',
      },
    }),
  });

  assert.equal(prisma.formSubmissions.length, 1);
  const stored = prisma.formSubmissions[0].data as Record<string, unknown>;
  assert.equal(stored.name, "alert('pwned')Mallory");
  assert.equal(stored.message, "click");
  assert.match(JSON.stringify(stored), /^(?!.*<script).*$/s, "pas de <script>");
  assert.match(
    JSON.stringify(stored),
    /^(?!.*javascript:).*$/is,
    "pas de javascript:",
  );
});
