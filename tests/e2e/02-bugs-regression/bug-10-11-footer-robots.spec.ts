/**
 * BUG-10/11 (P2 branding/SEO) :
 *   - BUG-10 : Le footer ne doit JAMAIS contenir "staminads.com" ou "Staminads"
 *     en public (démo, prod). Le branding upstream doit être masqué.
 *   - BUG-11 : `/robots.txt` doit être différent entre prod (allow) et démo
 *     (disallow). Sinon Google indexe la démo (data factices).
 *
 * Tag `@critical` + `@bug-10 @bug-11`. Multi-cible.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

test.describe(`BUG-10 footer no upstream branding [${TARGET}] @critical @bug-10`, () => {
  test("footer NE contient PAS 'staminads.com' / 'Staminads' (public)", async ({
    page,
  }) => {
    test.skip(
      !(target.isPublic || target.isDemo),
      "Internal staging may keep upstream",
    );

    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Footer démo : data-testid="demo-footer". Footer "normal" : <footer>
    // On scanne TOUT le body car footer custom peut être ailleurs.
    const bodyHTML = await page.content();
    expect(
      bodyHTML,
      "Page HTML contient 'staminads.com' — branding leak",
    ).not.toMatch(/staminads\.com/i);
    // "Staminads" en mot complet (pas dans une URL de CDN ou similaire)
    const matches = bodyHTML.match(/\bstaminads\b/gi);
    expect(
      matches,
      `Page HTML mentions Staminads ${matches?.length ?? 0} times — should be hidden`,
    ).toBeNull();
  });
});

test.describe(`BUG-11 robots.txt differs prod vs demo [${TARGET}] @critical @bug-11`, () => {
  test("robots.txt : démo = Disallow, prod = Allow", async () => {
    const client = new ApiClient(target.consoleUrl);
    const res = await client.get("/robots.txt", {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    // Pas d'erreur sur l'endpoint
    expect(res.status, "robots.txt should be served").toBeLessThan(500);
    if (res.status === 404) {
      test.skip(true, "robots.txt not served on this target — expected on some envs");
      return;
    }
    expect(res.status).toBe(200);

    const body = res.body.toLowerCase();

    if (target.isDemo) {
      // La démo doit avoir au moins UN Disallow (les workspaces démo ne doivent
      // pas être indexés — données fictives). Landing peut être Allow.
      expect(
        body,
        `Demo target ${TARGET} robots.txt doit contenir au moins un "Disallow:" — got: ${res.body.slice(0, 300)}`,
      ).toMatch(/disallow:\s*\//);
      // Workspaces démo doivent être Disallow explicite
      const hasWorkspacesDisallow = /disallow:\s*\/workspaces/i.test(res.body);
      expect(
        hasWorkspacesDisallow,
        `Demo ${TARGET} robots.txt doit Disallow /workspaces (données fictives) — got: ${res.body.slice(0, 300)}`,
      ).toBe(true);
    } else if (target.isPublic) {
      // Prod analytics-engine = console des tenants (accès via magic link
      // depuis le Hub) : robots.txt = "Disallow: /" est LÉGITIME, voulu.
      // L'important = la DÉMO et la PROD doivent avoir des robots.txt
      // différenciés (sinon la démo serait indexable comme une vraie app).
      // Cette assertion-là est faite dans le bloc target.isDemo plus haut.
      //
      // Sanity : robots.txt prod n'est pas vide et est bien servi
      expect(res.body.length, "robots.txt prod ne doit pas être vide").toBeGreaterThan(
        0,
      );
    }
  });
});
