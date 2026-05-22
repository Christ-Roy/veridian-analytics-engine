/**
 * E2E 05 — Shadow marketing public flow (A3).
 *
 * Le ticket A3 (déjà mergé sur dev) expose :
 *   GET /api/admin/shadow-marketing (PUBLIC — pas de Bearer)
 *
 * Retourne la liste des 6 services connus avec textes vendeurs configurés :
 *   - title, description, ctaLabel
 *   - emailSubject, emailBodyTemplate (contient {{domain}})
 *   - icon (clé de ShadowIconKey)
 *
 * Ces tests valident la STRUCTURE de la réponse — pas son contenu textuel
 * (susceptible d'être édité par marketing).
 */

import { test, expect } from "@playwright/test";
import {
  bootBridgeForTest,
  type BridgeFixture,
} from "../helpers/bridge-fixture.js";
import {
  KNOWN_SHADOW_SERVICES,
  KNOWN_SHADOW_ICONS,
} from "../helpers/fixtures.js";

let bridge: BridgeFixture;

test.beforeAll(async () => {
  bridge = await bootBridgeForTest();
});

test.afterAll(async () => {
  await bridge?.close();
});

test.describe("Shadow marketing — endpoint public", () => {
  test("GET /api/admin/shadow-marketing (sans Bearer) → 200 + 6 services", async () => {
    const res = await fetch(`${bridge.url}/api/admin/shadow-marketing`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Endpoint retourne directement le Record<ServiceKey, Entry> (pas wrappé)
    const keys = Object.keys(body);
    expect(keys).toHaveLength(KNOWN_SHADOW_SERVICES.length);
    for (const k of KNOWN_SHADOW_SERVICES) {
      expect(keys).toContain(k);
    }
  });

  test("chaque service a tous les champs requis non vides", async () => {
    const res = await fetch(`${bridge.url}/api/admin/shadow-marketing`);
    const body = await res.json();
    for (const key of KNOWN_SHADOW_SERVICES) {
      const svc = body[key];
      expect(svc, `service ${key} doit être défini`).toBeDefined();
      expect(svc.title, `${key}.title`).toBeTruthy();
      expect(svc.description, `${key}.description`).toBeTruthy();
      expect(svc.ctaLabel, `${key}.ctaLabel`).toBeTruthy();
      expect(svc.emailSubject, `${key}.emailSubject`).toBeTruthy();
      expect(svc.emailBodyTemplate, `${key}.emailBodyTemplate`).toBeTruthy();
      expect(svc.icon, `${key}.icon`).toBeTruthy();
      expect(
        KNOWN_SHADOW_ICONS.includes(svc.icon),
        `${key}.icon must be in ShadowIconKey (got: ${svc.icon})`
      ).toBe(true);
    }
  });

  test("emailBodyTemplate contient le placeholder {{domain}}", async () => {
    const res = await fetch(`${bridge.url}/api/admin/shadow-marketing`);
    const body = await res.json();
    for (const key of KNOWN_SHADOW_SERVICES) {
      const svc = body[key];
      expect(svc.emailBodyTemplate).toContain("{{domain}}");
    }
  });

  test("endpoint immuable — appelé 10x retourne le même payload", async () => {
    const res1 = await fetch(`${bridge.url}/api/admin/shadow-marketing`);
    const body1 = await res1.json();
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${bridge.url}/api/admin/shadow-marketing`);
      const body = await res.json();
      expect(body).toEqual(body1);
    }
  });

  test("Content-Type response = application/json", async () => {
    const res = await fetch(`${bridge.url}/api/admin/shadow-marketing`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
