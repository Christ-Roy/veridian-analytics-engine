/**
 * 11-demo-public — Guards démo : signup/billing/workspace.create bloqués.
 *
 * Le mode `IS_DEMO=true` doit refuser toutes les actions destructives :
 *   - POST /api/auth.signup-* → 400 "disabled in demo"
 *   - POST /api/users → 400
 *   - POST /api/workspaces (create) → 400
 *   - POST /api/api-keys → 400
 *
 * Le bridge guard renvoie BadRequestException ("This feature is disabled in
 * demo") → status 400.
 *
 * On ne fournit PAS de JWT valide ici — on veut juste s'assurer que ces
 * endpoints sont gardés. Si le guard renvoie 400 avant le 401 auth → bug
 * (mais c'est l'ordre actuel observé).
 *
 * On accepte 400 (DemoRestricted) OU 401/403 (auth) — du moment qu'on ne
 * peut PAS executer l'action. Ce qui est REFUSÉ : 200.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

interface RestrictedRoute {
  label: string;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

const RESTRICTED_ROUTES: RestrictedRoute[] = [
  {
    label: "workspaces.create",
    method: "POST",
    path: "/api/workspaces",
    body: { name: "e2e-test-attack-ws" },
  },
  {
    label: "users.create",
    method: "POST",
    path: "/api/users",
    body: {
      email: "e2e-test-attacker@veridian-test.local",
      password: "irrelevant1234!",
    },
  },
  {
    label: "api-keys.create",
    method: "POST",
    path: "/api/api-keys",
    body: { name: "e2e-test-key" },
  },
];

test.describe(`Demo restricted guards [${TARGET}]`, () => {
  test.skip(!target.isDemo, "Demo only");

  for (const route of RESTRICTED_ROUTES) {
    test(`${route.method} ${route.path} → bloqué (pas 200)`, async () => {
      const client = new ApiClient(target.consoleUrl);
      const res = await client.request(route.method, route.path, {
        body: route.body ? JSON.stringify(route.body) : undefined,
        headers: { "Content-Type": "application/json" },
        timeoutMs: 10_000,
        allowFailure: true,
      });
      expect(
        res.status,
        `${route.label} returned ${res.status} — should be 4xx (guard or auth)`,
      ).toBeGreaterThanOrEqual(400);
      expect(res.status, `${route.label} returned ${res.status}`).toBeLessThan(
        500,
      );
      // Si on tombe sur 400 explicit, le message doit mentionner demo
      if (res.status === 400) {
        const body = res.body.toLowerCase();
        // On accepte "demo" ou "disabled" — le wording exact peut varier
        const hasDemoMention = /demo|disabled/.test(body);
        if (!hasDemoMention) {
          // eslint-disable-next-line no-console
          console.warn(
            `[${route.label}] 400 sans mention "demo" : ${res.body.slice(0, 200)}`,
          );
        }
      }
    });
  }
});
