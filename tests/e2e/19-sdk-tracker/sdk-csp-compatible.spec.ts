/**
 * 19-sdk-tracker — Le SDK doit fonctionner sous CSP strict (pas de eval/new Function).
 *
 * On charge le script et on grep le contenu pour des patterns interdits par
 * CSP strict.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const TRACKER_PATHS = ["/js/tracker.js", "/js/script.js", "/tracker.js"];

test.describe(`SDK CSP strict mode [${TARGET}] @sdk`, () => {
  test("Tracker bundle ne contient pas eval() ou new Function()", async () => {
    let body: string | null = null;
    for (const p of TRACKER_PATHS) {
      const res = await fetch(`${target.engineUrl}${p}`);
      if (res.status === 200) {
        body = await res.text();
        break;
      }
    }
    if (!body) {
      test.skip(true, "Pas de tracker URL");
      return;
    }
    // CSP strict refuse eval() — anti-pattern dans un tracker SDK
    expect(body).not.toMatch(/\beval\s*\(/);
    expect(body).not.toMatch(/new\s+Function\s*\(/);
  });

  test("Tracker bundle est valide JS (peut être parsé par new Function)", async () => {
    let body: string | null = null;
    for (const p of TRACKER_PATHS) {
      const res = await fetch(`${target.engineUrl}${p}`);
      if (res.status === 200) {
        body = await res.text();
        break;
      }
    }
    if (!body) {
      test.skip(true, "Pas de tracker URL");
      return;
    }
    // Best-effort syntax check : on essaie de parser sans exécuter
    expect(() => {
      // eslint-disable-next-line no-new-func
      new Function(body!);
    }).not.toThrow();
  });
});
