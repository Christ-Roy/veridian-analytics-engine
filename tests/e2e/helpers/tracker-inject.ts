/**
 * Tracker-inject helper — sert une page HTML test et injecte le snippet
 * staminads via `page.route()`.
 *
 * Pattern :
 *   ```ts
 *   await injectTrackerPage(page, target, { siteKey: ctx.siteKey });
 *   await page.goto("http://e2e.test/index.html"); // domaine fictif intercepté
 *   ```
 *
 * Le domaine `http://e2e.test/*` est intercepté par `page.route()` — JAMAIS
 * de vrai network call vers un site externe.
 */

import type { Page } from "@playwright/test";
import type { Target } from "./targets";

export interface InjectOpts {
  siteKey: string;
  /** Domaine fictif. Default "http://e2e.test". */
  fakeOrigin?: string;
  /** Extra HTML body content. */
  bodyHtml?: string;
  /** Délai après tracker init avant resolve (ms). Default 0. */
  postInitDelayMs?: number;
}

const TRACKER_SCRIPT_PATH = "/js/tracker.js";
const FAKE_ORIGIN_DEFAULT = "http://e2e.test";

/**
 * Génère la page HTML test avec le snippet tracker.
 */
export function buildTrackerHtml(
  target: Target,
  opts: InjectOpts,
): string {
  const origin = opts.fakeOrigin ?? FAKE_ORIGIN_DEFAULT;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>E2E tracker test page</title>
<meta name="referrer" content="no-referrer-when-downgrade">
<script defer
  src="${target.engineUrl}${TRACKER_SCRIPT_PATH}"
  data-site="${opts.siteKey}"
  data-host="${target.engineUrl}"
  data-domain="${new URL(origin).hostname}"></script>
</head>
<body>
<h1>E2E tracker test page</h1>
<p>Site key: ${opts.siteKey}</p>
${opts.bodyHtml ?? ""}
<a id="link-to-page2" href="/page2.html">Page 2</a>
</body>
</html>`;
}

/**
 * Intercepte un domaine fictif et sert la page HTML avec tracker injecté.
 *
 * @returns une fonction `unroute()` pour démonter l'interception après le test.
 */
export async function injectTrackerPage(
  page: Page,
  target: Target,
  opts: InjectOpts,
): Promise<() => Promise<void>> {
  const origin = opts.fakeOrigin ?? FAKE_ORIGIN_DEFAULT;
  const url = `${origin}/**`;
  const html = buildTrackerHtml(target, opts);

  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html,
    });
  });

  return async () => {
    await page.unroute(url);
  };
}

/**
 * Construit l'URL où naviguer dans Playwright après `injectTrackerPage`.
 */
export function trackerTestUrl(
  fakeOrigin: string = FAKE_ORIGIN_DEFAULT,
  path: string = "/index.html",
): string {
  return `${fakeOrigin}${path}`;
}
