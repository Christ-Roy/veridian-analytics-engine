/**
 * 03-forms-leads — Edge cases payload : unicode, taille max, replay, iframe.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";
import { testRunId } from "../fixtures/test-data";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Forms payload edge cases [${TARGET}] @forms`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge forms");

  test("Payload Unicode/emoji → accepté sans crash", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey: `stm_pub_e2e_unicode_${testRunId()}`,
        formSlug: "e2e-test-form",
        data: {
          name: "测试 🚀 José François",
          message: "Émojis : 🎉🔥💯 et accents éàù",
        },
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    // 404 (siteKey unknown) attendu, jamais 500
    expect(res.status).toBeLessThan(500);
    expect([400, 404, 200, 201, 202]).toContain(res.status);
  });

  test("Payload énorme (>1MB) → 413 ou 400 (pas 500)", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const huge = "x".repeat(2 * 1024 * 1024); // 2MB
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey: `stm_pub_e2e_huge_${testRunId()}`,
        formSlug: "e2e-test-form",
        data: { message: huge },
      },
      { allowFailure: true, timeoutMs: 20_000 },
    );
    expect([400, 404, 413]).toContain(res.status);
  });

  test("Payload avec champs imbriqués profonds (anti DoS)", async () => {
    const client = new ApiClient(target.bridgeUrl);
    // Crée un objet profondément imbriqué pour tester anti-DoS parser
    let nested: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 100; i++) {
      nested = { wrap: nested };
    }
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey: `stm_pub_e2e_nested_${testRunId()}`,
        formSlug: "e2e-test",
        data: nested,
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect(res.status).toBeLessThan(500);
  });

  test("Form sans email → 400 ou 200 (accepté lead anonyme)", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey: `stm_pub_e2e_noemail_${testRunId()}`,
        formSlug: "e2e-test-form",
        data: { name: "Anonymous E2E", message: "Hello" },
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect([200, 201, 202, 400, 404]).toContain(res.status);
  });
});

test.describe(`Forms missing/invalid sitekey [${TARGET}] @forms`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge forms");

  test("siteKey absent (champ manquant) → 400", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/ingest/form",
      {
        formSlug: "e2e-no-sitekey",
        data: { email: "e2e@veridian-test.local" },
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect([400, 401, 404]).toContain(res.status);
  });

  test("siteKey format invalide → 400/401/404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/ingest/form",
      {
        siteKey: "not_a_valid_format!@#",
        formSlug: "e2e",
        data: { email: "e2e@veridian-test.local" },
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect([400, 401, 404]).toContain(res.status);
  });
});
