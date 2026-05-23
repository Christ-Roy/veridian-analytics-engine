/**
 * Playwright config — Veridian Analytics Engine E2E battery (v0.5.0+)
 *
 * Cibles testées (URLs RÉELLES, jamais de stack locale) :
 *   - prod         : https://analytics-engine.app.veridian.site
 *   - staging      : https://analytics-engine.staging.veridian.site
 *   - demo prod    : https://demo-analytics.veridian.site
 *   - demo staging : https://demo-staging-analytics.veridian.site
 *
 * Sélection via env var TARGET (default: staging). Override par test via
 * `withTarget()` helper si un test doit taper plusieurs cibles.
 *
 * 3 projets Playwright :
 *   - chromium-desktop : viewport 1920x1080, default
 *   - chromium-mobile  : Pixel 7 (375x819), pour mobile spec
 *   - webkit-desktop   : compat Safari (smoke uniquement)
 *
 * Doc complète : docs/E2E-TESTING.md
 */

import { defineConfig, devices } from "@playwright/test";
import { getTarget, type TargetName } from "./helpers/targets";

const TARGET_NAME = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET_NAME);

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
        ["junit", { outputFile: "test-results/junit.xml" }],
        // JSON report for scripts/ci/e2e-report-to-issues.mjs
        ["json", { outputFile: "test-results/results.json" }],
      ]
    : [["list"]],

  outputDir: "test-results",

  use: {
    baseURL: target.consoleUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: {
      "X-E2E-Test-Run": process.env.GITHUB_RUN_ID || "local",
      "X-E2E-Target": TARGET_NAME,
    },
  },

  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: "chromium-mobile",
      grep: /@mobile/,
      use: {
        ...devices["Pixel 7"],
      },
    },
    {
      name: "webkit-desktop",
      grep: /@webkit/,
      use: {
        ...devices["Desktop Safari"],
      },
    },
  ],
});

export { target, TARGET_NAME };
