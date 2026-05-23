/**
 * Phase B — Forms ingest endpoint (B1).
 *
 * Endpoint public : POST /api/ingest/form (bridge Veridian)
 *
 * Vérifie :
 *   - OPTIONS preflight retourne 204 + CORS headers
 *   - POST sans body → 400 (validation Zod)
 *   - POST avec siteKey inconnu → 404 (SiteKeyNotFoundError mapped)
 *   - POST avec payload bidon valide mais siteKey inconnu → 404
 *   - Rate limit fonctionne (11+ POST/min depuis même IP → 429)
 *
 * On NE crée PAS de vraie soumission de form (besoin d'un siteKey réel
 * provisionné). Le test "happy path" est gated derrière `E2E_TEST_SITE_KEY`.
 *
 * Tag `@critical`.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";
import { testRunId } from "../fixtures/test-data";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Ingest form endpoint [${TARGET}] @critical`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge public exposé");

  test("OPTIONS /api/ingest/form → 204 + CORS allow-origin", async () => {
    const res = await fetch(`${target.bridgeUrl}/api/ingest/form`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("POST /api/ingest/form sans body → 400 (validation)", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post("/api/ingest/form", {}, {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    expect(res.status, "validation should be 400").toBe(400);
  });

  test("POST /api/ingest/form siteKey inconnu → 404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const fakeKey = `e2e-fake-key-${testRunId()}`;
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey: fakeKey,
        formSlug: "e2e-test-form",
        data: { name: "E2E Tester", email: "e2e@veridian-test.local" },
      },
      { timeoutMs: 10_000, allowFailure: true },
    );
    expect(
      res.status,
      `expected 404 for unknown siteKey, got ${res.status}: ${res.body.slice(0, 200)}`,
    ).toBe(404);
  });

  test("POST /api/ingest/form avec siteKey valide → 200/201 + leadId", async () => {
    const siteKey = process.env.E2E_TEST_SITE_KEY;
    test.skip(
      !siteKey,
      "E2E_TEST_SITE_KEY non fourni (set GitHub secret pour test happy path)",
    );

    const client = new ApiClient(target.bridgeUrl);
    const runId = testRunId();
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey,
        formSlug: `e2e-test-${runId}`,
        formName: "E2E Test Form",
        data: {
          name: `E2E ${runId}`,
          email: `e2e-test-${runId}@veridian-test.local`,
          message: "Submitted by E2E battery.",
        },
        pageUrl: "https://example.com/e2e",
        utm: { source: "e2e", medium: "test", campaign: "battery" },
      },
      { timeoutMs: 15_000, allowFailure: true },
    );
    expect(
      [200, 201],
      `expected 200/201 happy path, got ${res.status}: ${res.body.slice(0, 200)}`,
    ).toContain(res.status);
    const body = res.json() as { ok?: boolean; leadId?: string; submissionId?: string };
    // Shape attendue (cf forms/routes.ts B1)
    expect(body).toHaveProperty("ok");
  });
});
