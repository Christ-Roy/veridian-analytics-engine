/**
 * Lighthouse runner helper — stub minimaliste avec budgets WCAG/perf.
 *
 * On préfère lighthouse-ci en CLI dans le workflow plutôt que SDK en spec.
 * Cette utilité fournit juste les budgets numériques utilisés par les
 * `14-perf-regression/*.spec.ts` qui s'appuient sur Playwright pour mesurer
 * (pas lighthouse direct — trop lourd à embarquer).
 *
 * Pour le vrai lighthouse score, voir `.github/workflows/e2e-perf-regression.yml`
 * qui invoque `lhci autorun` directement contre les URLs cibles.
 */

export interface PerfBudget {
  /** First Contentful Paint (ms). */
  fcpMs: number;
  /** Largest Contentful Paint (ms). */
  lcpMs: number;
  /** Cumulative Layout Shift (unitless). */
  cls: number;
  /** Time To Interactive (ms). */
  ttiMs: number;
  /** Total Blocking Time (ms). */
  tbtMs: number;
}

export const BUDGETS = {
  dashboardDesktop: {
    fcpMs: 2_000,
    lcpMs: 2_500,
    cls: 0.1,
    ttiMs: 3_000,
    tbtMs: 300,
  } satisfies PerfBudget,
  dashboardMobile: {
    fcpMs: 3_000,
    lcpMs: 4_000,
    cls: 0.15,
    ttiMs: 5_000,
    tbtMs: 500,
  } satisfies PerfBudget,
  demo: {
    fcpMs: 2_500,
    lcpMs: 3_000,
    cls: 0.1,
    ttiMs: 3_500,
    tbtMs: 350,
  } satisfies PerfBudget,
};

/**
 * Bundle size budgets (KB).
 */
export const BUNDLE_BUDGETS = {
  dashboardInitialJsKB: 500,
  trackerSdkJsGzKB: 10,
};

/**
 * Mesure FCP/LCP/CLS via Playwright Web Vitals.
 *
 * Inject window.__VITALS et collecte via web-vitals lib chargée par tracker.
 */
export async function measureCoreVitals(
  page: import("@playwright/test").Page,
  url: string,
  opts: { waitMs?: number } = {},
): Promise<{ fcp: number; lcp: number; cls: number }> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  // Attendre les vitals
  await page.waitForTimeout(opts.waitMs ?? 3_000);

  const vitals = await page.evaluate(() => {
    return new Promise<{ fcp: number; lcp: number; cls: number }>((resolve) => {
      let fcp = 0;
      let lcp = 0;
      let cls = 0;

      try {
        const fcpEntry = performance.getEntriesByName(
          "first-contentful-paint",
        )[0];
        if (fcpEntry) fcp = fcpEntry.startTime;

        const lcpObs = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length > 0) {
            lcp = entries[entries.length - 1].startTime;
          }
        });
        lcpObs.observe({ type: "largest-contentful-paint", buffered: true });

        const clsObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as PerformanceEntry[] &
            { hadRecentInput?: boolean; value?: number }[]) {
            const e = entry as PerformanceEntry & {
              hadRecentInput?: boolean;
              value?: number;
            };
            if (!e.hadRecentInput && typeof e.value === "number")
              cls += e.value;
          }
        });
        clsObs.observe({ type: "layout-shift", buffered: true });

        setTimeout(() => resolve({ fcp, lcp, cls }), 1_500);
      } catch {
        resolve({ fcp: 0, lcp: 0, cls: 0 });
      }
    });
  });

  return vitals;
}
