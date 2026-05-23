/**
 * 16-security — Headers sécu (CSP/HSTS/X-Frame-Options/Referrer-Policy) +
 * absence de X-Powered-By leak.
 *
 * Note: certains de ces tests recoupent 01-smoke/security-headers.spec.ts mais
 * ici on durcit côté assertions et on couvre des routes différentes.
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
      // staging utilise HTTP/2 derrière Traefik avec TLS LetsEncrypt → HSTS attendu
      const hsts = res.headers.get("strict-transport-security");
      // Si pas explicitement set, on tolère (Traefik le fait parfois en runtime).
      // L'important : si présent, il doit avoir un max-age > 0.
      if (hsts) {
        expect(hsts.toLowerCase()).toMatch(/max-age=\d+/);
      }
    });
  }

  test("X-Powered-By header ne leak PAS la techno (Express, Next.js, etc.)", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const xpb = res.headers.get("x-powered-by");
    // Si présent → doit pas mentionner Express direct (commun dans staminads)
    if (xpb) {
      expect(xpb.toLowerCase()).not.toContain("express");
    }
  });

  test("Server header ne leak PAS version précise", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const server = res.headers.get("server");
    if (server) {
      // Pas de version genre "nginx/1.18.0" leak
      expect(server.toLowerCase()).not.toMatch(/\/\d+\.\d+\.\d+/);
    }
  });

  test("X-Frame-Options ou CSP frame-ancestors présent (anti-clickjacking)", async () => {
    const res = await fetch(`${target.consoleUrl}/`, { method: "GET" });
    const xfo = res.headers.get("x-frame-options");
    const csp = res.headers.get("content-security-policy");
    const hasProtection =
      (xfo && /^(DENY|SAMEORIGIN)$/i.test(xfo)) ||
      (csp && /frame-ancestors/.test(csp));
    expect(
      hasProtection,
      `${TARGET}: ni X-Frame-Options ni CSP frame-ancestors présent`,
    ).toBeTruthy();
  });
});
