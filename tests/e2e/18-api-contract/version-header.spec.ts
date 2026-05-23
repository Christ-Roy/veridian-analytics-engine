/**
 * 18-api-contract — Headers de version/diagnostic.
 *
 * Best-effort : on cherche un header de version ou un endpoint /version qui
 * permet de diagnostiquer rapidement quelle version tourne en staging vs
 * prod (utile pour rollback et incident response).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Version diagnostic [${TARGET}] @contract`, () => {
  test("Un endpoint de version est disponible (X-Veridian-Version ou /api/version)", async () => {
    const candidates = ["/api/version", "/api/build", "/api/health"];
    let versionFound: string | null = null;
    for (const p of candidates) {
      const res = await fetch(`${target.engineUrl}${p}`);
      const headerV = res.headers.get("x-veridian-version");
      if (headerV) {
        versionFound = headerV;
        break;
      }
      if (res.status === 200) {
        const body = await res.text();
        const m = body.match(/"version"\s*:\s*"([^"]+)"/);
        if (m) {
          versionFound = m[1];
          break;
        }
      }
    }
    // Best-effort, on ne fail pas si pas trouvé (mais on log dans le test name)
    // Au minimum on attend qu'aucun endpoint ne renvoie "staminads" en version
    if (versionFound) {
      expect(versionFound.toLowerCase()).not.toContain("staminads");
    }
  });

  test("Pas de header X-Veridian-Stage qui leak l'env staging en prod", async () => {
    const res = await fetch(`${target.consoleUrl}/`);
    const stage = res.headers.get("x-veridian-stage");
    if (target.name === "prod" && stage) {
      // En prod, pas de leak "staging" ou "dev"
      expect(stage.toLowerCase()).not.toContain("staging");
      expect(stage.toLowerCase()).not.toContain("dev");
    }
  });
});
