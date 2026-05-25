/**
 * 21-anti-regression-2026-05-25 — Francisation (anti-régression).
 *
 * Sprint commercial 2026-05-25 : Robert a figé l'app en FR par défaut (vision
 * `project_analytics_vision_scope_final` + `CLAUDE.md`). Toute la console est
 * en français in-place, pas de système i18n. Vouvoiement, accents préservés.
 *
 * Risque anti-régression : un agent qui resync depuis upstream staminads (EN
 * par défaut) ou qui ajoute un composant sans traduction → strings EN qui
 * reviennent. Ces tests catchent ça à froid.
 *
 * Couvre :
 *   1. <html lang="fr"> sur la SPA shell
 *   2. <title>Veridian Analytics</title> (pas "Staminads", pas EN)
 *   3. /login (page publique, sans auth) montre au moins 3 strings FR clés
 *   4. /api/public-config exposé et retourne un payload cohérent FR/Veridian
 *
 * Cibles : staging + prod (les démos sont publiques mais ont leur propre
 * branding démo, on skip).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Francisation (anti-régression) [${TARGET}] @i18n @anti-regression @branding`, () => {
  test('SPA shell : <html lang="fr">', async ({ page }) => {
    // Arrange + Act
    const res = await page.goto(`${target.consoleUrl}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Assert
    expect(res?.status() ?? 0).toBeLessThan(500);
    const htmlLang = await page.locator("html").getAttribute("lang");
    expect(
      htmlLang,
      `${TARGET}: <html lang> absent ou pas "fr" (= ${htmlLang}) — régression i18n`,
    ).toBeTruthy();
    expect(htmlLang!.toLowerCase()).toMatch(/^fr(-fr)?$/);
  });

  test('SPA shell : <title> contient "Veridian Analytics" (pas Staminads)', async ({
    page,
  }) => {
    // Arrange + Act
    await page.goto(`${target.consoleUrl}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Assert
    const title = await page.title();
    expect(
      title,
      `${TARGET}: <title> vide — régression branding`,
    ).toBeTruthy();
    // On exige "Veridian" dans le titre (peut être suivi de "Analytics" ou
    // d'un suffixe page). Et on interdit "Staminads" qui serait un leak
    // upstream.
    expect(
      title.toLowerCase(),
      `${TARGET}: <title>="${title}" doit contenir "veridian"`,
    ).toContain("veridian");
    expect(
      title.toLowerCase(),
      `${TARGET}: <title>="${title}" leak "staminads" = régression rebrand`,
    ).not.toContain("staminads");
  });

  test("/login : au moins 3 strings FR clés visibles", async ({ page }) => {
    // Arrange + Act
    const res = await page.goto(`${target.consoleUrl}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(500);

    // Attendre que React monte le formulaire (sinon on chope juste la SPA shell
    // vide). On utilise un selector tolérant : n'importe quel input/form
    // suffit comme proof-of-mount.
    await page
      .waitForSelector('input, form, button[type="submit"]', { timeout: 10_000 })
      .catch(() => {
        // Si le mount échoue, on continue quand même — le content-check
        // ci-dessous fera fail proprement avec un message clair.
      });

    // Act : on slurp tout le HTML rendu (innerText du body, lowercased)
    const bodyText = (await page.locator("body").innerText()).toLowerCase();

    // Assert : on cherche au moins 3 strings FR clés parmi un pool de
    // candidats raisonnables sur une page de login Veridian francisée.
    // On tolère plusieurs formes (ex: "mot de passe" / "mot de passe oublié")
    // pour ne pas casser au moindre wording change.
    const FR_CANDIDATES = [
      "connexion",
      "se connecter",
      "mot de passe",
      "adresse e-mail",
      "adresse email",
      "courriel",
      "oublié",
      "inscription",
      "créer un compte",
      "identifiant",
      "bienvenue",
      "continuer",
      "valider",
    ];
    const matched = FR_CANDIDATES.filter((s) => bodyText.includes(s));
    expect(
      matched.length,
      `${TARGET}: /login ne contient que ${matched.length} strings FR (matched=${JSON.stringify(matched)}). ` +
        `Attendu ≥ 3 parmi ${JSON.stringify(FR_CANDIDATES)}. ` +
        `Régression i18n : la page est probablement repassée en EN.`,
    ).toBeGreaterThanOrEqual(3);

    // Anti-régression bonus : on interdit explicitement les strings EN
    // canoniques staminads upstream qui ne devraient JAMAIS apparaître.
    expect(bodyText).not.toContain("forgot your password");
    expect(bodyText).not.toContain("sign in to your account");
  });

  test("/api/public-config : payload exposé + timezone FR/Europe", async () => {
    // Arrange
    const client = new ApiClient(target.consoleUrl);

    // Act
    const res = await client.get("/api/public-config", {
      timeoutMs: 10_000,
      allowFailure: true,
    });

    // Assert
    // L'endpoint doit exister sur staging/prod (404 = régression : on l'a
    // câblé pendant le sprint). On accepte 200 strict.
    expect(
      res.status,
      `${TARGET}: /api/public-config status=${res.status} — endpoint disparu ?`,
    ).toBe(200);

    const body = res.json() as Record<string, unknown>;

    // Le payload doit au minimum exposer un default_timezone OU un locale FR.
    // On tolère plusieurs clés possibles selon l'évolution du schéma —
    // ce test ne doit pas casser si Robert ajoute des champs ; il casse
    // uniquement si on perd toute trace de FR / Europe dans le payload.
    const payloadJson = JSON.stringify(body).toLowerCase();
    const frHints = [
      "europe/paris",
      "europe/london", // tolérance : certaines configs partagent UE
      "fr-fr",
      '"fr"',
      "veridian",
    ];
    const matched = frHints.filter((s) => payloadJson.includes(s));
    expect(
      matched.length,
      `${TARGET}: /api/public-config payload n'a aucun indice FR/Veridian. ` +
        `Payload=${payloadJson.slice(0, 300)}. ` +
        `Attendu au moins 1 parmi ${JSON.stringify(frHints)}.`,
    ).toBeGreaterThanOrEqual(1);
  });
});
