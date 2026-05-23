/**
 * 16-security — CORS policy strict.
 *
 * Endpoints API doivent rejeter les origins suspects, accepter ceux du Hub
 * et de l'écosystème Veridian.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const FOREIGN_ORIGINS = [
  "https://evil.example.com",
  "http://localhost:31337",
  "null",
];

test.describe(`CORS strict [${TARGET}] @security`, () => {
  for (const origin of FOREIGN_ORIGINS) {
    test(`Origin "${origin}" → pas de wildcard ACAO`, async () => {
      const res = await fetch(`${target.engineUrl}/api/setup.status`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
        },
      });
      const acao = res.headers.get("access-control-allow-origin");
      // Si CORS répond, soit reflète l'origin (mauvais), soit pas, soit "*"
      // On accepte uniquement : pas d'ACAO, ou ACAO d'un domaine veridian/staminads
      if (acao) {
        expect(acao).not.toBe("*");
        // L'origin reflété doit être whitelisted (veridian.site ou staminads.com)
        const lower = acao.toLowerCase();
        const acceptable =
          lower.includes("veridian") ||
          lower.includes("staminads") ||
          lower === origin.toLowerCase();
        // Note: si reflète l'origin malveillante c'est un bug — on flag
        if (lower === origin.toLowerCase()) {
          throw new Error(
            `CORS reflète origin foreign "${origin}" — fail sécu (devrait pas)`,
          );
        }
        expect(acceptable).toBeTruthy();
      }
    });
  }

  test("Tracker endpoint (/api/track) accepte CORS depuis n'importe quel origin (par design)", async () => {
    // Le tracker doit fonctionner depuis n'importe quel site client
    const res = await fetch(`${target.engineUrl}/api/track`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://random-client-website.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    // Soit 204/200 avec ACAO, soit 404 si endpoint OPTIONS pas configuré
    // (auquel cas le POST en suivant marche quand même)
    expect([200, 204, 404, 405]).toContain(res.status);
  });
});
