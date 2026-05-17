/**
 * Tests endpoint GET /health.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeStaminads, startAppOnEphemeralPort } from "./helpers/fake-staminads.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

let fake: FakeStaminads;
let bridgeUrl: string;
let closeBridge: () => Promise<void>;

beforeEach(async () => {
  fake = new FakeStaminads();
  await fake.start();
  const app = createApp({
    staminadsUrl: fake.url,
    adminEmail: "admin@veridian.local",
    adminPassword: "test-pass-2026",
    veridianAdminApiKey: ADMIN_KEY,
  });
  const started = await startAppOnEphemeralPort(app);
  bridgeUrl = started.url;
  closeBridge = started.close;
});

afterEach(async () => {
  await closeBridge();
  await fake.stop();
});

test("GET /health retourne 200 + status ok", async () => {
  const res = await fetch(`${bridgeUrl}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; staminadsUrl: string };
  assert.equal(body.status, "ok");
  assert.equal(body.staminadsUrl, fake.url);
});

test("GET /health: pas d'auth requise (utilisé par compose healthcheck)", async () => {
  const res = await fetch(`${bridgeUrl}/health`);
  assert.equal(res.status, 200);
});

test("GET /health: réponse JSON valide", async () => {
  const res = await fetch(`${bridgeUrl}/health`);
  assert.ok(res.headers.get("content-type")?.includes("application/json"));
});
