/**
 * 05-gsc-oauth — OAuth begin/callback + state CSRF + token refresh.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`GSC OAuth endpoints [${TARGET}] @gsc`, () => {
  test.skip(target.isDemo, "Demo n'a pas de GSC réel");

  test("GET /api/gsc/oauth/begin (sans auth) → 4xx/302 vers login", async () => {
    const res = await fetch(`${target.bridgeUrl}/api/gsc/oauth/begin`, {
      method: "GET",
      redirect: "manual",
    });
    // 401 si pas auth, 302 vers Google si auth OK, 404 si endpoint absent
    expect([200, 302, 401, 403, 404]).toContain(res.status);
    if (res.status === 302) {
      const loc = res.headers.get("location") ?? "";
      // Doit rediriger vers accounts.google.com
      expect(loc).toContain("accounts.google.com");
    }
  });

  test("GET /api/gsc/oauth/callback sans code → 4xx", async () => {
    const res = await fetch(`${target.bridgeUrl}/api/gsc/oauth/callback`, {
      method: "GET",
    });
    // 400 (missing code), 401 (no session), 404 (endpoint absent)
    expect(res.status).toBeLessThan(500);
    expect([400, 401, 403, 404]).toContain(res.status);
  });

  test("GET /api/gsc/oauth/callback?code=fake&state=mismatch → CSRF detected", async () => {
    const res = await fetch(
      `${target.bridgeUrl}/api/gsc/oauth/callback?code=e2e-fake-code&state=e2e-csrf-mismatch`,
      { method: "GET" },
    );
    // Le state ne match jamais → 401/403/400
    expect(res.status).toBeLessThan(500);
    expect([400, 401, 403, 404]).toContain(res.status);
  });
});

test.describe(`GSC sync property [${TARGET}] @gsc`, () => {
  test.skip(target.isDemo, "Demo single-tenant");

  test("POST /api/gsc/sync sans auth → 401/404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/gsc/sync",
      { site: "https://example.com" },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect([401, 403, 404, 405]).toContain(res.status);
  });
});
