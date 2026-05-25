/**
 * 21-anti-regression-2026-05-25 — Helmet headers (anti-régression durcie).
 *
 * Le helmet middleware a été ajouté côté API NestJS pendant le sprint 2026-05-25
 * (PR #33). Avant : prod leakait X-Powered-By: Express + AUCUNE CSP. Audit
 * commercial BUG-17 / BUG-18.
 *
 * Ce spec :
 *   1. Va plus loin que 16-security/headers-security.spec.ts en testant ALSO
 *      `/api/health` (héritage des headers sur l'API, pas juste la SPA shell)
 *   2. Verrouille les VALEURS exactes attendues (`x-frame-options: DENY` ;
 *      `referrer-policy: strict-origin-when-cross-origin` ; CSP avec
 *      `default-src 'self'`) — pas juste "présent"
 *   3. Catch toute régression côté `x-powered-by` (le leak Express tué)
 *
 * Si un futur agent désactive helmet ou bypasse le middleware, on chope tout
 * en rouge en moins de 5s.
 *
 * Cibles : staging + prod (toutes les cibles publiques).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

// Routes probées : la SPA shell (/) ET l'API health (/api/health). On veut
// vérifier que helmet pose les headers sur les DEUX, pas juste la SPA.
// Si seul `/` est headée mais que `/api/health` leak → un attaquant qui
// fingerprint la stack via l'API verra Express → régression.
const PROBE_PATHS = ["/", "/api/health"];

test.describe(`Helmet headers (anti-régression) [${TARGET}] @security @anti-regression @bug-17 @bug-18`, () => {
  for (const path of PROBE_PATHS) {
    test(`${path} — Content-Security-Policy stricte avec default-src 'self'`, async () => {
      // Arrange + Act
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
        redirect: "manual",
      });

      // Assert
      // Tolérer 4xx pour /api/health si l'endpoint n'existe pas — on cherche
      // surtout les headers. Mais > 500 = serveur cassé = test n/a.
      expect(res.status, `${path} status=${res.status} (serveur cassé ?)`).toBeLessThan(500);
      const csp = res.headers.get("content-security-policy");
      expect(
        csp,
        `${TARGET} ${path}: CSP absente — helmet contentSecurityPolicy désactivé ?`,
      ).toBeTruthy();
      expect(csp!.toLowerCase()).toContain("default-src 'self'");
    });

    test(`${path} — Strict-Transport-Security max-age ≥ 15552000`, async () => {
      // Arrange + Act
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
        redirect: "manual",
      });

      // Assert
      expect(res.status).toBeLessThan(500);
      const hsts = res.headers.get("strict-transport-security");
      expect(
        hsts,
        `${TARGET} ${path}: HSTS absent (helmet pas chargé sur cette route ?)`,
      ).toBeTruthy();
      const m = hsts!.match(/max-age=(\d+)/);
      const maxAge = m ? parseInt(m[1], 10) : 0;
      // helmet default = 15552000 (180 jours). Anti-régression : on exige
      // ≥ ce seuil. Inférieur = quelqu'un a downgradé la conf.
      expect(
        maxAge,
        `${TARGET} ${path}: HSTS max-age=${maxAge}s, attendu ≥ 15552000 (180j)`,
      ).toBeGreaterThanOrEqual(15552000);
    });

    test(`${path} — X-Frame-Options: DENY (anti-clickjacking strict)`, async () => {
      // Arrange + Act
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
        redirect: "manual",
      });

      // Assert
      expect(res.status).toBeLessThan(500);
      const xfo = res.headers.get("x-frame-options");
      expect(
        xfo,
        `${TARGET} ${path}: X-Frame-Options absent — helmet frameguard désactivé ?`,
      ).toBeTruthy();
      // helmet default = SAMEORIGIN ; notre conf force DENY.
      // Anti-régression : on exige DENY (strict). SAMEORIGIN = régression
      // car quelqu'un a relâché la conf helmet.
      expect(xfo!.toUpperCase()).toBe("DENY");
    });

    test(`${path} — X-Content-Type-Options: nosniff`, async () => {
      // Arrange + Act
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
        redirect: "manual",
      });

      // Assert
      expect(res.status).toBeLessThan(500);
      const xcto = res.headers.get("x-content-type-options");
      expect(
        xcto,
        `${TARGET} ${path}: X-Content-Type-Options absent`,
      ).toBeTruthy();
      expect(xcto!.toLowerCase()).toBe("nosniff");
    });

    test(`${path} — Referrer-Policy: strict-origin-when-cross-origin`, async () => {
      // Arrange + Act
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
        redirect: "manual",
      });

      // Assert
      expect(res.status).toBeLessThan(500);
      const referrer = res.headers.get("referrer-policy");
      expect(
        referrer,
        `${TARGET} ${path}: Referrer-Policy absent`,
      ).toBeTruthy();
      // helmet default = no-referrer ; notre conf = strict-origin-when-cross-origin.
      // Anti-régression : on tolère les variantes strictes mais PAS unsafe-url
      // ni no-referrer-when-downgrade (relax).
      expect(referrer!.toLowerCase()).toMatch(
        /^(strict-origin-when-cross-origin|strict-origin|same-origin|no-referrer)$/,
      );
    });

    test(`${path} — X-Powered-By ABSENT (anti-fingerprinting Express)`, async () => {
      // Arrange + Act
      const res = await fetch(`${target.consoleUrl}${path}`, {
        method: "GET",
        redirect: "manual",
      });

      // Assert
      expect(res.status).toBeLessThan(500);
      const xpb = res.headers.get("x-powered-by");
      // helmet désactive X-Powered-By par défaut, et `app.disable('x-powered-by')`
      // aussi. Si présent → leak techno Express = régression sécu = audit OWASP
      // qui passe rouge.
      expect(
        xpb,
        `${TARGET} ${path}: X-Powered-By présent (= ${xpb}) — leak Express = régression sprint 2026-05-25`,
      ).toBeNull();
    });
  }
});
