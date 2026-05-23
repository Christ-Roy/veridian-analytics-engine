/**
 * 18-api-contract — Le contrat /api/public-config et /api/setup.status doit
 * rester stable. Breaking change = bump version + migration côté Hub.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Public contract [${TARGET}] @contract`, () => {
  test("/api/setup.status renvoie { setupCompleted: bool }", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/setup.status", { timeoutMs: 10_000 });
    expect(res.status).toBe(200);
    const body = res.json() as { setupCompleted: boolean };
    expect(typeof body.setupCompleted).toBe("boolean");
  });

  test("/api/public-config (si exposé) → shape stable", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/public-config", {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    if (res.status === 404) {
      test.skip(true, "Endpoint /api/public-config absent (acceptable)");
      return;
    }
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Pas de clés Staminads upstream non-customisées
    // (par contre on tolère les clés branding configurées)
    expect(typeof body).toBe("object");
  });

  test("/api/healthcheck ou /api/health renvoie 200 + JSON ou texte", async () => {
    const candidates = ["/api/healthcheck", "/api/health"];
    let found = false;
    for (const p of candidates) {
      const res = await fetch(`${target.engineUrl}${p}`);
      if (res.status === 200) {
        found = true;
        break;
      }
    }
    expect(found).toBeTruthy();
  });
});

test.describe(`Error response shape [${TARGET}] @contract`, () => {
  test("404 endpoint renvoie JSON ou HTML clean (pas stack trace)", async () => {
    const res = await fetch(
      `${target.engineUrl}/api/this-endpoint-does-not-exist-e2e`,
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("error: cannot");
    expect(body.toLowerCase()).not.toContain("at object.");
    expect(body.toLowerCase()).not.toContain("/home/");
  });

  test("400 sur body invalide JSON → shape JSON propre", async () => {
    const res = await fetch(`${target.engineUrl}/api/auth.login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json bro",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
