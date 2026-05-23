/**
 * 16-security — Secrets ne doivent JAMAIS leak côté frontend ou dans les logs.
 *
 * On scanne le HTML public + les ressources JS pour détecter des patterns
 * de secrets (clés API, DB urls, AUTH_SECRET, etc.).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "AWS access key", regex: /AKIA[0-9A-Z]{16}/ },
  { name: "Stripe live key", regex: /sk_live_[0-9a-zA-Z]{24,}/ },
  {
    name: "Database URL (postgres)",
    regex: /postgres(?:ql)?:\/\/[^@\s]+@[^\s'"`]+/,
  },
  { name: "Private key block", regex: /-----BEGIN (RSA )?PRIVATE KEY-----/ },
  { name: "JWT secret hint", regex: /AUTH_SECRET\s*[:=]\s*['"]?[a-z0-9]{16,}/i },
  { name: "Internal admin token", regex: /BRIDGE_ADMIN_TOKEN\s*[:=]/i },
  { name: "HMAC secret", regex: /HUB_HMAC_SECRET\s*[:=]\s*['"]?[a-z0-9]{16,}/i },
];

test.describe(`Secrets no leak [${TARGET}] @security`, () => {
  test("HTML public ne contient aucun pattern de secret", async ({ page }) => {
    const res = await page.goto(target.consoleUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(500);
    const html = await page.content();
    for (const { name, regex } of SECRET_PATTERNS) {
      const match = html.match(regex);
      expect(
        match,
        `LEAK ${name} détecté dans HTML public: ${match?.[0]?.slice(0, 60)}`,
      ).toBeNull();
    }
  });

  test("Bundle JS principal ne contient pas de secret pattern", async ({
    page,
  }) => {
    const jsResources: string[] = [];
    page.on("response", async (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if (
        ct.includes("javascript") &&
        url.startsWith(target.consoleUrl) &&
        res.status() === 200
      ) {
        try {
          const body = await res.text();
          jsResources.push(body);
        } catch {
          /* ignore */
        }
      }
    });

    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });

    // best-effort: au moins le HTML doit avoir été checké, et si on a chopé du JS, on scanne
    if (jsResources.length === 0) {
      return; // pas de JS publique téléchargé, test skip best-effort
    }
    const concat = jsResources.join("\n");
    for (const { name, regex } of SECRET_PATTERNS) {
      const match = concat.match(regex);
      expect(
        match,
        `LEAK ${name} dans bundle JS: ${match?.[0]?.slice(0, 60)}`,
      ).toBeNull();
    }
  });

  test("Endpoint /api/public-config ne leak pas de secrets", async () => {
    const res = await fetch(`${target.engineUrl}/api/public-config`, {
      method: "GET",
    });
    if (res.status === 404) return; // route facultative
    expect(res.status).toBeLessThan(500);
    const body = await res.text();
    for (const { name, regex } of SECRET_PATTERNS) {
      const match = body.match(regex);
      expect(
        match,
        `LEAK ${name} dans /api/public-config`,
      ).toBeNull();
    }
  });
});
