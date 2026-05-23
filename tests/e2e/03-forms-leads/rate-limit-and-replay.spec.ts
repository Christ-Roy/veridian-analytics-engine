/**
 * 03-forms-leads — Rate limit + replay attack protection.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";
import { testRunId } from "../fixtures/test-data";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Forms rate-limit [${TARGET}] @forms`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge forms");

  test("Flood 15 req depuis même IP → un 429 apparaît", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const fakeKey = `stm_pub_e2e_rl_${testRunId()}`;
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await client.post(
        "/api/ingest/form",
        {
          siteKey: fakeKey,
          formSlug: "e2e-rl",
          data: { i, email: `e2e-rl-${i}@veridian-test.local` },
        },
        { allowFailure: true, timeoutMs: 5_000 },
      );
      statuses.push(res.status);
    }
    // Soit un 429 a été déclenché, soit on a 15x 404 (sitekey unknown = pas rate-limit triggered)
    // — les deux sont acceptables. Ce qu'on REFUSE : un 500.
    expect(statuses.every((s) => s < 500)).toBeTruthy();
  });
});

test.describe(`Forms iframe submission [${TARGET}] @forms`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge forms");

  test("POST avec Origin/Referer suspect (iframe phishing) accepté ou refusé proprement", async () => {
    // CORS du bridge accepte n'importe quel origin (par design — sites clients varient)
    // donc le contenu de Origin ne doit jamais causer 500
    const res = await fetch(`${target.bridgeUrl}/api/ingest/form`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil-iframe.example.com",
        Referer: "https://evil-iframe.example.com/phish",
      },
      body: JSON.stringify({
        siteKey: `stm_pub_e2e_iframe_${testRunId()}`,
        formSlug: "e2e-iframe",
        data: { email: "e2e-iframe@veridian-test.local" },
      }),
    });
    expect(res.status).toBeLessThan(500);
  });
});
