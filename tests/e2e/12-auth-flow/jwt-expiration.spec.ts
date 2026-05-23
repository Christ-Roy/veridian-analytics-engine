/**
 * 12-auth-flow — JWT expiration & tampering détecté.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`JWT validation [${TARGET}] @security`, () => {
  test.skip(target.isDemo, "Demo a son propre token éphémère");

  test("Endpoint privé sans token → 401", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/workspace.list", {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("Token JWT tampered (corrupted signature) → 401", async () => {
    const client = new ApiClient(target.engineUrl);
    // JWT format: header.payload.signature — on corrompt la signature
    const tamperedJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlMmUtdGFtcGVyZWQifQ.this-is-NOT-a-valid-sig";
    const res = await client.get("/api/workspace.list", {
      headers: { Authorization: `Bearer ${tamperedJwt}` },
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403]).toContain(res.status);
  });

  test("Token JWT alg=none → 401 (algorithm confusion)", async () => {
    const client = new ApiClient(target.engineUrl);
    // JWT alg=none classique CVE pattern
    const noneJwt =
      "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJlMmUtbm9uZSIsInJvbGUiOiJhZG1pbiJ9.";
    const res = await client.get("/api/workspace.list", {
      headers: { Authorization: `Bearer ${noneJwt}` },
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403]).toContain(res.status);
  });

  test("Token JWT expiré (exp = 1) → 401", async () => {
    const client = new ApiClient(target.engineUrl);
    // Fake JWT avec exp dans le passé (1970)
    // header: {"alg":"HS256","typ":"JWT"} → eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
    // payload: {"sub":"e2e","exp":1} → eyJzdWIiOiJlMmUiLCJleHAiOjF9
    const expiredJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlMmUiLCJleHAiOjF9.fake-sig";
    const res = await client.get("/api/workspace.list", {
      headers: { Authorization: `Bearer ${expiredJwt}` },
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403]).toContain(res.status);
  });
});
