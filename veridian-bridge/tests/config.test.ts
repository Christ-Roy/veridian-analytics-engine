/**
 * Tests pour validateConfig() — couverture des invariants de config.
 * Source : src/app.ts (validateConfig + createApp).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, createApp, type BridgeConfig } from "../src/app.js";

const VALID: BridgeConfig = {
  staminadsUrl: "http://staminads:3000",
  platformAdminApiKey: "x".repeat(48),
  veridianAdminApiKey: "x".repeat(32),
};

test("validateConfig: accepte une config valide", () => {
  assert.doesNotThrow(() => validateConfig(VALID));
});

test("validateConfig: rejette API key trop courte", () => {
  assert.throws(
    () => validateConfig({ ...VALID, veridianAdminApiKey: "short" }),
    /veridianAdminApiKey/
  );
});

test("validateConfig: rejette API key vide", () => {
  assert.throws(
    () => validateConfig({ ...VALID, veridianAdminApiKey: "" }),
    /veridianAdminApiKey/
  );
});

test("validateConfig: rejette URL sans http", () => {
  assert.throws(
    () => validateConfig({ ...VALID, staminadsUrl: "staminads:3000" }),
    /staminadsUrl/
  );
});

test("validateConfig: accepte https", () => {
  assert.doesNotThrow(() =>
    validateConfig({ ...VALID, staminadsUrl: "https://staminads.example.com" })
  );
});

test("validateConfig: rejette platformAdminApiKey trop courte", () => {
  assert.throws(
    () => validateConfig({ ...VALID, platformAdminApiKey: "short" }),
    /platformAdminApiKey/
  );
});

test("validateConfig: rejette platformAdminApiKey vide", () => {
  assert.throws(
    () => validateConfig({ ...VALID, platformAdminApiKey: "" }),
    /platformAdminApiKey/
  );
});

test("createApp: lève si config invalide", () => {
  assert.throws(() => createApp({ ...VALID, veridianAdminApiKey: "" }));
});

test("createApp: retourne une Express app pour config valide", () => {
  const app = createApp(VALID);
  assert.ok(app);
  assert.equal(typeof app.use, "function");
  assert.equal(typeof app.listen, "function");
});
