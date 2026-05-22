/**
 * Playwright config — analytics-engine E2E
 *
 * Deux modes :
 *  1. Local — `BRIDGE_URL` non défini → boot un bridge local sur port éphémère
 *     via les helpers de tests (utile pour CI staging local + dev).
 *  2. Remote — `BRIDGE_URL` défini (ex CI staging/prod smoke) → tests pointent
 *     directement sur l'URL distante (pas de webServer).
 *
 * Les smoke tests (smoke/) sont volontairement minimalistes — endpoints publics
 * sans Bearer — pour qu'ils tournent en post-deploy CI sans secret.
 *
 * Les promise-flows/ tests démarrent un bridge local + faux staminads, donc
 * ils tournent même sans URL externe.
 */

import { defineConfig, devices } from "@playwright/test";

const BRIDGE_URL = process.env.BRIDGE_URL || "";
const ENGINE_URL = process.env.ENGINE_URL || "";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "list" : "line",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BRIDGE_URL || "http://127.0.0.1:3002",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    extraHTTPHeaders: {
      // Headers par défaut pour tracer requêtes E2E dans les logs
      "X-E2E-Test-Run": process.env.GITHUB_RUN_ID || "local",
    },
  },

  projects: [
    {
      name: "smoke",
      testMatch: /smoke\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "promise-flows",
      testMatch: /promise-flows\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Pas de webServer global — chaque test promise-flow boot son propre bridge.
});

export { BRIDGE_URL, ENGINE_URL };
