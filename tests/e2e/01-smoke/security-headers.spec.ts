/**
 * 01-smoke — Headers de sécurité.
 *
 * On exige sur les routes publiques :
 *   - Strict-Transport-Security (HSTS)
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: DENY ou SAMEORIGIN
 *   - Referrer-Policy
 *
 * Bloquant : la régression côté headers fait sauter l'audit OWASP.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

interface HeaderCheck {
  name: string;
  /** Si la valeur doit matcher un regex. Si undefined → présence seule. */
  matches?: RegExp;
  /** Mark comme warn-only (log mais pas fail). */
  warnOnly?: boolean;
}

const REQUIRED_HEADERS: HeaderCheck[] = [
  { name: "strict-transport-security", matches: /max-age=\d+/ },
  { name: "x-content-type-options", matches: /nosniff/i },
  { name: "x-frame-options", matches: /(DENY|SAMEORIGIN)/i },
  { name: "referrer-policy", matches: /.+/ },
];

const RECOMMENDED_HEADERS: HeaderCheck[] = [
  { name: "permissions-policy", warnOnly: true },
  { name: "content-security-policy", warnOnly: true },
];

async function checkHeaders(url: string, label: string): Promise<void> {
  const client = new ApiClient(url);
  // On tape un endpoint qu'on sait dispo
  const probePath = url.includes("bridge") ? "/health" : "/api/setup.status";
  const res = await client.get(probePath, {
    timeoutMs: 15_000,
    allowFailure: true,
  });
  expect(res.status, `${label} probe ${probePath}`).toBeLessThan(500);

  // Required headers
  for (const h of REQUIRED_HEADERS) {
    const val = res.headers[h.name];
    expect(val, `${label} missing required header "${h.name}"`).toBeTruthy();
    if (h.matches) {
      expect(val, `${label} header "${h.name}" value="${val}"`).toMatch(
        h.matches,
      );
    }
  }

  // Recommended headers (warn-only) — log mais ne fail pas
  for (const h of RECOMMENDED_HEADERS) {
    const val = res.headers[h.name];
    if (!val) {
      // eslint-disable-next-line no-console
      console.warn(
        `[${label}] recommended header "${h.name}" missing (warn-only)`,
      );
    }
  }
}

test.describe(`Security headers [${TARGET}]`, () => {
  test(`engine/console headers`, async () => {
    await checkHeaders(target.engineUrl, "engine");
  });

  test(`bridge headers`, async () => {
    test.skip(target.isDemo, "Demo bridge identique à console");
    await checkHeaders(target.bridgeUrl, "bridge");
  });
});
