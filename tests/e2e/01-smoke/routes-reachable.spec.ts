/**
 * 01-smoke — Routes principales reachable.
 *
 * On vérifie que les chemins critiques répondent (pas 5xx, pas timeout).
 * On ne valide PAS le contenu HTML ici (c'est le job des tests 09-dashboard-ui).
 *
 * Bloquant : un 5xx au root = rollback.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

interface RouteCheck {
  path: string;
  /** Status codes acceptés. */
  expectedStatuses: number[];
  /** Si la route est dispo uniquement sur engine ou seulement bridge. */
  baseUrl: "engineUrl" | "bridgeUrl" | "consoleUrl";
  /** Skip selon la cible (utile pour endpoints non exposés en démo). */
  skipIf?: (t: typeof target) => boolean;
}

const ROUTES: RouteCheck[] = [
  // Engine root → console SPA (200) ou redirect login (302/3xx)
  {
    path: "/",
    expectedStatuses: [200, 301, 302, 303, 307, 308],
    baseUrl: "consoleUrl",
  },
  // setup.status — toujours dispo (engine)
  {
    path: "/api/setup.status",
    expectedStatuses: [200],
    baseUrl: "engineUrl",
  },
  // public-config — démo only (ne pas tester sur staging/prod car peut-être absent)
  {
    path: "/api/public-config",
    expectedStatuses: [200],
    baseUrl: "consoleUrl",
    skipIf: (t) => !t.isDemo,
  },
  // bridge health (engine targets only)
  {
    path: "/health",
    expectedStatuses: [200],
    baseUrl: "bridgeUrl",
    skipIf: (t) => t.isDemo,
  },
  // shadow-marketing config (engine targets only)
  {
    path: "/api/admin/shadow-marketing",
    expectedStatuses: [200],
    baseUrl: "bridgeUrl",
    skipIf: (t) => t.isDemo,
  },
];

test.describe(`Routes reachable [${TARGET}]`, () => {
  for (const route of ROUTES) {
    const label = `${route.baseUrl}${route.path} → ${route.expectedStatuses.join("|")}`;
    test(label, async () => {
      if (route.skipIf?.(target)) {
        test.skip(true, `Skipped for target ${target.name}`);
      }
      const base = target[route.baseUrl];
      const client = new ApiClient(base);
      const res = await client.get(route.path, {
        timeoutMs: 15_000,
        allowFailure: true,
        redirect: "manual",
      });
      expect(
        route.expectedStatuses,
        `route ${base}${route.path} returned ${res.status}`,
      ).toContain(res.status);
      // No 5xx tolerated.
      expect(res.status, `5xx for ${base}${route.path}`).toBeLessThan(500);
    });
  }
});
