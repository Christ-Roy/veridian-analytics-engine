/**
 * Tests shadow-marketing — config statique + endpoint public.
 *
 * Vérifie :
 *   1. Les 6 services de KNOWN_SERVICES ont une entrée
 *   2. Chaque entrée a tous les champs requis (title, description, ctaLabel,
 *      emailSubject, emailBodyTemplate, icon)
 *   3. emailBodyTemplate contient bien le placeholder `{{domain}}`
 *   4. GET /api/admin/shadow-marketing → 200 + JSON valide (pas d'auth)
 *   5. L'endpoint répond même sans Bearer (data publique marketing)
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { startAppOnEphemeralPort } from "./helpers/fake-staminads.js";
import { KNOWN_SERVICES } from "../src/tenant-status.js";
import {
  SHADOW_MARKETING,
  type ShadowMarketingEntry,
  type ShadowIconKey,
} from "../src/shadow-marketing.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

const VALID_ICONS: readonly ShadowIconKey[] = [
  "phone",
  "inbox",
  "line-chart",
  "search",
  "megaphone",
  "gauge",
  "bell",
];

let closeBridge: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (closeBridge) {
    await closeBridge();
    closeBridge = null;
  }
});

async function bootBridge(): Promise<string> {
  const app = createApp({
    staminadsUrl: "http://127.0.0.1:1", // jamais appelé sur cet endpoint
    adminEmail: "admin@veridian.local",
    adminPassword: "test-pass-2026",
    veridianAdminApiKey: ADMIN_KEY,
  });
  const started = await startAppOnEphemeralPort(app);
  closeBridge = started.close;
  return started.url;
}

// ─── Config statique (data) ────────────────────────────────────────────

test("SHADOW_MARKETING: les 6 services KNOWN_SERVICES ont une entrée", () => {
  for (const service of KNOWN_SERVICES) {
    assert.ok(
      SHADOW_MARKETING[service],
      `Service "${service}" doit avoir une entrée dans SHADOW_MARKETING`,
    );
  }
  // Aucun service en trop : la map a exactement 6 clés
  assert.equal(
    Object.keys(SHADOW_MARKETING).length,
    KNOWN_SERVICES.length,
    "SHADOW_MARKETING doit contenir exactement les 6 services de KNOWN_SERVICES",
  );
});

test("SHADOW_MARKETING: chaque entrée a tous les champs requis", () => {
  for (const service of KNOWN_SERVICES) {
    const entry = SHADOW_MARKETING[service];
    assert.equal(typeof entry.title, "string", `${service}.title doit être string`);
    assert.ok(entry.title.length > 0, `${service}.title ne doit pas être vide`);

    assert.equal(
      typeof entry.description,
      "string",
      `${service}.description doit être string`,
    );
    assert.ok(
      entry.description.length > 0,
      `${service}.description ne doit pas être vide`,
    );

    assert.equal(
      typeof entry.ctaLabel,
      "string",
      `${service}.ctaLabel doit être string`,
    );
    assert.ok(entry.ctaLabel.length > 0, `${service}.ctaLabel ne doit pas être vide`);

    assert.equal(
      typeof entry.emailSubject,
      "string",
      `${service}.emailSubject doit être string`,
    );
    assert.ok(
      entry.emailSubject.length > 0,
      `${service}.emailSubject ne doit pas être vide`,
    );

    assert.equal(
      typeof entry.emailBodyTemplate,
      "string",
      `${service}.emailBodyTemplate doit être string (pas une fonction comme le legacy)`,
    );
    assert.ok(
      entry.emailBodyTemplate.length > 0,
      `${service}.emailBodyTemplate ne doit pas être vide`,
    );

    assert.equal(typeof entry.icon, "string", `${service}.icon doit être string`);
    assert.ok(
      VALID_ICONS.includes(entry.icon),
      `${service}.icon "${entry.icon}" doit être une ShadowIconKey valide`,
    );
  }
});

test("SHADOW_MARKETING: emailBodyTemplate contient le placeholder {{domain}}", () => {
  for (const service of KNOWN_SERVICES) {
    const entry: ShadowMarketingEntry = SHADOW_MARKETING[service];
    assert.ok(
      entry.emailBodyTemplate.includes("{{domain}}"),
      `${service}.emailBodyTemplate doit contenir le placeholder "{{domain}}" pour permettre au front d'injecter le domaine`,
    );
  }
});

// ─── Endpoint ──────────────────────────────────────────────────────────

test("GET /api/admin/shadow-marketing: 200 + JSON valide (pas d'auth)", async () => {
  const url = await bootBridge();
  const res = await fetch(`${url}/api/admin/shadow-marketing`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("application/json"));

  const body = (await res.json()) as Record<string, ShadowMarketingEntry>;
  // Le JSON contient bien les 6 services
  for (const service of KNOWN_SERVICES) {
    assert.ok(body[service], `body["${service}"] présent dans la réponse JSON`);
    assert.equal(body[service].title, SHADOW_MARKETING[service].title);
    assert.equal(
      body[service].emailBodyTemplate,
      SHADOW_MARKETING[service].emailBodyTemplate,
    );
    assert.ok(
      body[service].emailBodyTemplate.includes("{{domain}}"),
      `body["${service}"].emailBodyTemplate doit survivre la sérialisation JSON avec son placeholder`,
    );
  }
});

test("GET /api/admin/shadow-marketing: endpoint public (Bearer absent → 200 quand même)", async () => {
  const url = await bootBridge();
  // Pas de header Authorization du tout
  const res = await fetch(`${url}/api/admin/shadow-marketing`);
  assert.equal(
    res.status,
    200,
    "endpoint marketing public ne doit pas demander de Bearer",
  );
});

test("GET /api/admin/shadow-marketing: Bearer invalide → 200 (endpoint public, ignore l'auth)", async () => {
  const url = await bootBridge();
  const res = await fetch(`${url}/api/admin/shadow-marketing`, {
    headers: { Authorization: "Bearer totally-wrong-key" },
  });
  assert.equal(
    res.status,
    200,
    "endpoint marketing public ignore l'Authorization header",
  );
});
