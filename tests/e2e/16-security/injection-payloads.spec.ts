/**
 * 16-security — Injection payloads (SQL, NoSQL, XSS, prototype pollution).
 *
 * On envoie des payloads malicieux à différents endpoints publics. Le serveur
 * doit :
 *   - Soit refuser (4xx)
 *   - Soit accepter mais ne pas exécuter le payload (échappe, sanitize)
 *   - Jamais 500 (erreur interne révèle stack)
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const SQL_PAYLOADS = [
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  "1' UNION SELECT * FROM users--",
];

const XSS_PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "javascript:alert(1)",
  "<svg/onload=alert(1)>",
];

const NOSQL_PAYLOADS: unknown[] = [
  { $gt: "" },
  { $ne: null },
  { email: { $regex: ".*" } },
];

const PROTO_POLLUTION_PAYLOADS: unknown[] = [
  { __proto__: { polluted: true } },
  { constructor: { prototype: { polluted: true } } },
];

test.describe(`Injection payloads [${TARGET}] @security`, () => {
  for (const payload of SQL_PAYLOADS) {
    test(`POST /api/auth.login with SQLi payload "${payload.slice(0, 20)}…" → 4xx clean`, async () => {
      const client = new ApiClient(target.engineUrl);
      const res = await client.post(
        "/api/auth.login",
        { email: payload, password: payload },
        { allowFailure: true, timeoutMs: 10_000 },
      );
      // Doit pas 500, doit pas leak stack
      expect(res.status).not.toBe(500);
      expect(res.body.toLowerCase()).not.toContain("syntax error");
      expect(res.body.toLowerCase()).not.toContain("sqlstate");
      expect(res.body.toLowerCase()).not.toContain("at object.");
    });
  }

  for (const payload of XSS_PAYLOADS) {
    test(`POST /api/ingest/form with XSS payload "${payload.slice(0, 20)}…" (sanitized or escaped)`, async () => {
      const client = new ApiClient(target.engineUrl);
      const res = await client.post(
        "/api/ingest/form",
        {
          site_key: "stm_pub_e2e_xss_test",
          fields: { name: payload, message: payload },
        },
        { allowFailure: true, timeoutMs: 10_000 },
      );
      // 400 (validation) / 401 (sitekey unknown) / 404 / 202 (queued)
      expect([200, 201, 202, 400, 401, 403, 404]).toContain(res.status);
      expect(res.status).not.toBe(500);
      // La réponse JSON ne doit jamais reflect le payload sans escape
      if (res.headers["content-type"]?.includes("json")) {
        expect(res.body).not.toContain("<script>");
      }
    });
  }

  for (const payload of NOSQL_PAYLOADS) {
    test(`POST /api/auth.login with NoSQL injection ${JSON.stringify(payload).slice(0, 30)}…`, async () => {
      const client = new ApiClient(target.engineUrl);
      const res = await client.post(
        "/api/auth.login",
        { email: payload, password: "anything" },
        { allowFailure: true, timeoutMs: 10_000 },
      );
      // Prisma utilise pg/pg-bouncer → injection NoSQL doit échouer (4xx, jamais 200)
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(500);
    });
  }

  for (const payload of PROTO_POLLUTION_PAYLOADS) {
    test(`POST /api/auth.login with prototype pollution payload ${JSON.stringify(payload).slice(0, 30)}…`, async () => {
      const client = new ApiClient(target.engineUrl);
      const res = await client.post("/api/auth.login", payload, {
        allowFailure: true,
        timeoutMs: 10_000,
      });
      // doit fail validation (400) — pas crash 500
      expect(res.status).not.toBe(500);
    });
  }
});

test.describe(`Path traversal [${TARGET}] @security`, () => {
  const TRAVERSAL_PAYLOADS = [
    "/../../etc/passwd",
    "/..%2F..%2Fetc%2Fpasswd",
    "/static/../../../etc/passwd",
  ];

  for (const path of TRAVERSAL_PAYLOADS) {
    test(`GET ${path} → pas de leak fichier système`, async () => {
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
      });
      const body = await res.text();
      // /etc/passwd contient root:x:0:0:root:/root:/bin/bash
      expect(body).not.toContain("root:x:0:0");
      expect(body).not.toContain("/bin/bash");
    });
  }
});

test.describe(`Open redirect [${TARGET}] @security`, () => {
  test("GET /login?redirect=https://evil.example.com → pas de redirect vers evil", async ({
    page,
  }) => {
    test.skip(target.isDemo, "Demo n'a pas de /login");
    const res = await page.goto(
      `${target.consoleUrl}/login?redirect=https://evil.example.com/phish`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    expect(res?.status() ?? 0).toBeLessThan(400);
    // L'URL finale doit rester sur target.hostname
    expect(page.url()).toContain(target.hostname);
    expect(page.url()).not.toContain("evil.example.com");
  });
});
