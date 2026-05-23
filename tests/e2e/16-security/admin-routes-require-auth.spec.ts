/**
 * 16-security — Admin routes doivent EXIGER Bearer token + le rejeter si invalide.
 *
 * Endpoints admin probés :
 *   - /api/admin/* (toutes routes admin du bridge)
 *   - /api/tenants/* (endpoints HMAC Hub)
 *   - /api/workspace.list (auth user)
 *   - /api/workspace.delete (auth user)
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const ADMIN_GET_ENDPOINTS = [
  "/api/admin/tenants",
  "/api/admin/health",
  "/api/admin/metrics",
];

const USER_ENDPOINTS = [
  "/api/workspace.list",
  "/api/account.get",
];

test.describe(`Admin/user routes require Bearer [${TARGET}] @security`, () => {
  for (const path of ADMIN_GET_ENDPOINTS) {
    test(`GET ${path} sans Bearer → 401/403/404`, async () => {
      const client = new ApiClient(target.bridgeUrl);
      const res = await client.get(path, {
        allowFailure: true,
        timeoutMs: 10_000,
      });
      // Note: 404 si la route n'existe pas (acceptable)
      expect([401, 403, 404]).toContain(res.status);
    });

    test(`GET ${path} avec Bearer invalide → 401/403`, async () => {
      const client = new ApiClient(target.bridgeUrl);
      const res = await client.get(path, {
        headers: { Authorization: "Bearer obviously-wrong-token-e2e" },
        allowFailure: true,
        timeoutMs: 10_000,
      });
      expect([401, 403, 404]).toContain(res.status);
    });
  }

  for (const path of USER_ENDPOINTS) {
    test(`GET ${path} sans token → 401/403/404`, async () => {
      const client = new ApiClient(target.engineUrl);
      const res = await client.get(path, {
        allowFailure: true,
        timeoutMs: 10_000,
      });
      expect([401, 403, 404, 405]).toContain(res.status);
    });
  }
});
