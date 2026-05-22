/**
 * B1 — Test rate limit : 11e req/min depuis la même IP → 429.
 *
 * Configure un rate limiter custom (max=10/min) puis envoie 11 requêtes
 * en série depuis la même IP simulée (header x-forwarded-for).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import {
  createRateLimiter,
  registerFormsRoutes,
} from "../../src/forms/index.js";
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

async function startApp(
  prisma: FakePrismaClientWithForms,
  max: number,
): Promise<Started> {
  const app = express();
  app.use(express.json());
  // express derrière proxy doit faire confiance au x-forwarded-for pour
  // que `req.ip` soit correct, et notre helper getClientIp lit aussi
  // l'header directement.
  app.set("trust proxy", true);
  registerFormsRoutes(app, {
    prisma: prisma as unknown as PrismaClient,
    requireAdmin: (_req, _res, next) => next(),
    staminadsUrl: "http://fake",
    fetchImpl: stubFetch,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max }),
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
      siteKey: "sk_rl",
      domain: "test.com",
      name: "Test Site",
    },
  });
});

afterEach(async () => {
  if (app) await app.close();
});

test("11e req depuis même IP → 429", async () => {
  app = await startApp(prisma, 10);
  const url = app.url;
  const ip = "203.0.113.42";

  for (let i = 0; i < 10; i++) {
    const r: Response = await fetch(`${url}/api/ingest/form`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({
        siteKey: "sk_rl",
        formSlug: "spam",
        data: { i },
      }),
    });
    assert.equal(r.status, 200, `req ${i + 1} OK`);
  }

  const res11: Response = await fetch(`${url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ siteKey: "sk_rl", formSlug: "spam", data: {} }),
  });
  assert.equal(res11.status, 429);
  assert.equal(res11.headers.get("retry-after"), "60");
  const body = (await res11.json()) as { error: string; retryAfterSec: number };
  assert.equal(body.error, "rate_limited");
  assert.equal(body.retryAfterSec, 60);
});

test("IPs différentes → buckets indépendants", async () => {
  app = await startApp(prisma, 2);
  const url = app.url;

  // IP A : 2 ok puis 1 bloqué
  for (let i = 0; i < 2; i++) {
    const r: Response = await fetch(`${url}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.1.1.1" },
      body: JSON.stringify({ siteKey: "sk_rl", formSlug: "f", data: {} }),
    });
    assert.equal(r.status, 200);
  }
  const blocked: Response = await fetch(`${url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "1.1.1.1" },
    body: JSON.stringify({ siteKey: "sk_rl", formSlug: "f", data: {} }),
  });
  assert.equal(blocked.status, 429);

  // IP B : passe encore
  const fromB: Response = await fetch(`${url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "2.2.2.2" },
    body: JSON.stringify({ siteKey: "sk_rl", formSlug: "f", data: {} }),
  });
  assert.equal(fromB.status, 200);
});
