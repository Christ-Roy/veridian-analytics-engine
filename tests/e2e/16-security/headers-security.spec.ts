/**
 * 16-security — Headers sécu (CSP/HSTS/X-Frame-Options/Referrer-Policy) +
 * absence de X-Powered-By leak.
 *
 * Note: certains de ces tests recoupent 01-smoke/security-headers.spec.ts mais
 * ici on durcit côté assertions et on couvre des routes différentes.
 *
 * 2026-05-25 — Durci suite à BUG-17/BUG-18 (audit commercial) :
 *   - les anciennes assertions étaient tolérantes (`if (header) { ... }`) et
 *     laissaient passer une prod sans CSP ni helmet → faux positif systémique.
 *   - le job CI `e2e-security-audit.yml` mettait aussi `|| true` après
 *     `npx playwright test`, donc même un fail réel ne cassait pas le job.
 *   - le helmet a été ajouté côté API (`api/src/main.ts`), ces tests doivent
 *     maintenant CONSTATER la présence ferme des headers.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const PROBE_PATHS = ["/", "/login", "/api/setup.status"];

test.describe(`Security headers [${TARGET}] @security`, () => {
  for (const path of PROBE_PATHS) {
    test(`HSTS header present on ${path}`, async () => {
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
        redirect: "manual",
      });
      const hsts = res.headers.get("strict-transport-security");
      // helmet pose HSTS systématiquement (maxAge ≥ 1 jour, includeSubDomains).
      expect(
        hsts,
        `${TARGET}: HSTS header absent sur ${path} (helmet pas chargé ?)`,
      ).toBeTruthy();
      expect(hsts!.toLowerCase()).toMatch(/max-age=\d+/);
      // Sanity : le max-age doit être ≥ 1 jour (86400s). Inférieur = mal configuré.
      const m = hsts!.match(/max-age=(\d+)/);
      const maxAge = m ? parseInt(m[1], 10) : 0;
      expect(
        maxAge,
        `${TARGET}: HSTS max-age=${maxAge} trop court sur ${path}`,
      ).toBeGreaterThanOrEqual(86400);
    });
  }

  test("X-Powered-By header absent (anti-fingerprinting Express)", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const xpb = res.headers.get("x-powered-by");
    // helmet désactive X-Powered-By, et `app.disable('x-powered-by')` aussi.
    // Si présent → leak techno = régression sécu.
    expect(
      xpb,
      `${TARGET}: X-Powered-By présent (= ${xpb}) — helmet désactivé ?`,
    ).toBeNull();
  });

  test("Server header ne leak PAS version précise", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const server = res.headers.get("server");
    if (server) {
      // Pas de version genre "nginx/1.18.0" leak
      expect(server.toLowerCase()).not.toMatch(/\/\d+\.\d+\.\d+/);
    }
  });

  test("Content-Security-Policy header présent (BUG-17)", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const csp =
      res.headers.get("content-security-policy") ??
      res.headers.get("content-security-policy-report-only");
    expect(
      csp,
      `${TARGET}: CSP absente sur / (helmet contentSecurityPolicy pas chargé ?)`,
    ).toBeTruthy();
    // Directives minimales attendues par notre policy (cf main.ts).
    expect(csp!.toLowerCase()).toContain("default-src");
    expect(csp!.toLowerCase()).toContain("frame-ancestors");
    expect(csp!.toLowerCase()).toContain("object-src");
  });

  test("X-Frame-Options ou CSP frame-ancestors présent (anti-clickjacking)", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const xfo = res.headers.get("x-frame-options");
    const csp = res.headers.get("content-security-policy");
    const hasProtection =
      (xfo && /^(DENY|SAMEORIGIN)$/i.test(xfo)) ||
      (csp && /frame-ancestors\s+['"]?(none|self)['"]?/i.test(csp));
    expect(
      hasProtection,
      `${TARGET}: ni X-Frame-Options ni CSP frame-ancestors strict présent`,
    ).toBeTruthy();
  });

  test("Referrer-Policy header présent", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const referrer = res.headers.get("referrer-policy");
    expect(
      referrer,
      `${TARGET}: Referrer-Policy absent (helmet pas chargé ?)`,
    ).toBeTruthy();
    // strict-origin-when-cross-origin recommandé. no-referrer accepté aussi.
    expect(referrer!.toLowerCase()).toMatch(
      /(strict-origin|same-origin|no-referrer|origin)/,
    );
  });

  test("X-Content-Type-Options: nosniff présent", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const xcto = res.headers.get("x-content-type-options");
    expect(
      xcto,
      `${TARGET}: X-Content-Type-Options absent (helmet pas chargé ?)`,
    ).toBeTruthy();
    expect(xcto!.toLowerCase()).toBe("nosniff");
  });
});
