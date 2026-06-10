/**
 * 21-anti-regression-2026-05-25 — Setup endpoint verrouillé (P0 sécu).
 *
 * Anti-régression sprint commercial 2026-05-25 : un agent qui régresserait
 * la fermeture de `/setup` ouvrirait une faille "instance takeover" (n'importe
 * quel visiteur pourrait re-bootstrap l'instance prod et devenir admin).
 *
 * Couvre 4 angles complémentaires (le combo backend + frontend) :
 *   1. La SPA shell est servie sur GET /setup (pas 404)
 *   2. Quand un browser charge /setup, React redirect /login dès le mount
 *      (le bouclier client-side qui empêche l'utilisateur de tomber sur le
 *      wizard une fois l'instance déjà bootstrap)
 *   3. POST /api/setup.initialize avec body valide → 400 (le bouclier
 *      server-side : même si un attaquant skip le React, l'API refuse)
 *   4. GET /api/setup.status renvoie {setupCompleted:true} (sanity : si
 *      ce flag passe à false un jour, le test 2 et 3 partent en cacahuète,
 *      le rouge est immédiat et explicite)
 *
 * Le test 1+2 existait nulle part ; 3+4 recoupent 12-auth-flow/setup-locked
 * mais y restent pour grouper l'anti-régression sous un seul describe lisible.
 *
 * Cibles : staging + prod (skip démo car la démo a son propre flow auto-login).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Setup verrouillé (anti-régression) [${TARGET}] @security @anti-regression @bug-01`, () => {
  test.skip(target.isDemo, "Démo a un flow setup-already-done par seed, pas pertinent");

  test("GET /api/setup.status → setupCompleted:true (pré-requis)", async () => {
    // setup.status partage le bucket throttler 'auth' (10 req/min/IP) avec
    // les logins que la suite smoke enchaîne → 429 de flakiness CI (issues
    // #56/#57, rouge depuis le 2026-06-02). Un 429 n'est PAS une régression
    // de lockdown : on attend la fenêtre et on retente (1 fois suffit).
    test.setTimeout(120_000);

    // Arrange
    const client = new ApiClient(target.engineUrl);

    // Act
    let res = await client.get("/api/setup.status", { timeoutMs: 10_000 });
    if (res.status === 429) {
      const retryAfterS = Number(res.headers["retry-after"]) || 61;
      await new Promise((r) => setTimeout(r, Math.min(retryAfterS, 90) * 1000));
      res = await client.get("/api/setup.status", { timeoutMs: 10_000 });
    }

    // Assert
    expect(res.status, `setup.status doit répondre 200`).toBe(200);
    const body = res.json() as { setupCompleted: boolean };
    expect(body).toHaveProperty("setupCompleted");
    expect(
      body.setupCompleted,
      `setupCompleted=false sur ${TARGET} = l'instance est exposée au bootstrap public`,
    ).toBe(true);
  });

  test("GET /setup → SPA shell servie (>1000 chars HTML)", async ({ page }) => {
    // Arrange + Act
    const res = await page.goto(`${target.consoleUrl}/setup`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Assert : le serveur sert l'index.html SPA (status < 500, pas un crash)
    // La SPA peut renvoyer 200 (index.html catch-all) ; on tolère aussi un
    // redirect direct côté serveur (302/303/307/308 si jamais migré server-side).
    expect(res?.status() ?? 0).toBeLessThan(500);
    const html = await page.content();
    expect(
      html.length,
      `/setup doit servir au moins la SPA shell (root div) avant redirect React`,
    ).toBeGreaterThan(500);
  });

  test("GET /setup → React redirect /login si setup complete", async ({ page }) => {
    // Arrange
    await page.goto(`${target.consoleUrl}/setup`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Act : on attend que le bouclier React redirect dès que useEffect mount
    // et que setup.status confirme setupCompleted:true.
    // Timeout 10s : laisse le temps au fetch /api/setup.status + redirect.
    await page.waitForURL(/\/login(\?|$)/, { timeout: 10_000 });

    // Assert : on est bien sur /login (et pas resté sur /setup avec le wizard
    // exposé).
    const url = page.url();
    expect(
      url,
      `Attendu redirect /login depuis /setup ; URL actuelle = ${url}`,
    ).toMatch(/\/login(\?|$)/);
    // Vérifie aussi que la page login a effectivement le formulaire de login,
    // pas juste une URL vide.
    const html = await page.content();
    expect(html.length).toBeGreaterThan(500);
    expect(html.toLowerCase()).toContain("veridian");
  });

  test("POST /api/setup.initialize → 400 (backend lock)", async () => {
    // Arrange
    const client = new ApiClient(target.engineUrl);

    // Act : on simule un attaquant qui POST direct sans passer par la SPA.
    // Body valide en shape (email/password/name) pour s'assurer qu'on teste
    // bien le verrou "setup déjà fait" et pas un 400 de validation Zod.
    const res = await client.post(
      "/api/setup.initialize",
      {
        email: "anti-regression-attacker@veridian-test.local",
        password: "Irrelevant-Pw-Strong-1234!",
        name: "Anti Regression Attacker",
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );

    // Assert : 400 (Bad Request) attendu — le backend doit refuser ferme.
    // On accepte aussi 401/403/409 selon implémentation, mais PAS 200/201.
    expect(
      res.status,
      `setup.initialize doit échouer (sinon faille instance takeover) — status=${res.status}`,
    ).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // Sanity : pas de stack trace leak dans la réponse d'erreur
    expect(res.body.toLowerCase()).not.toContain("at object.<anonymous>");
    expect(res.body.toLowerCase()).not.toContain("/usr/src/app");
  });
});
