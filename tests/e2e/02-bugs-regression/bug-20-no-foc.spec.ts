/**
 * BUG-20 (P2 perf/UX) — Pas de FOUC (Flash Of Unstyled Content).
 *
 * Trouvé par bug-hunter : sur slow 3G, la page démo affiche brièvement du
 * HTML non stylé avant que la CSS bundle Vite charge. Mitigation : CSS
 * critique inliné dans `<head>` (style ou link rel=preload pour le bundle).
 *
 * Test anti-régression :
 *   - HTML brut (sans JS exec) contient AU MOINS un `<style>` non-vide OU
 *     un `<link rel="stylesheet">` ou `<link rel="preload" as="style">` dans `<head>`
 *
 * On utilise `fetch` brut (pas Playwright) car on veut le HTML serveur,
 * pas le DOM hydraté.
 *
 * Tag `@bug-20`. Public targets only.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

test.describe(`BUG-20 critical CSS in head [${TARGET}] @bug-20`, () => {
  test("HTML brut du root inclut une feuille CSS dans <head>", async () => {
    const res = await fetch(target.consoleUrl, {
      redirect: "follow",
      headers: { "User-Agent": "veridian-e2e/1.0" },
    });
    expect(res.status, "root must respond 2xx").toBeLessThan(400);
    const html = await res.text();

    // Extrait la section <head>
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    expect(headMatch, "<head> tag found in HTML").toBeTruthy();
    const head = headMatch![1];

    // Au moins une de ces conditions :
    //   - <style>...{...}</style> non-vide
    //   - <link rel="stylesheet" href="...">
    //   - <link rel="preload" as="style" href="...">
    //   - <link rel="modulepreload"> (Vite injecte des modulepreload)
    const hasInlineStyle = /<style[^>]*>[^<]*\{[^<]*\}/.test(head);
    const hasStylesheet = /<link[^>]+rel=["']stylesheet["']/.test(head);
    const hasPreloadStyle =
      /<link[^>]+rel=["']preload["'][^>]+as=["']style["']/.test(head);
    const hasModulePreload = /<link[^>]+rel=["']modulepreload["']/.test(head);

    expect(
      hasInlineStyle || hasStylesheet || hasPreloadStyle || hasModulePreload,
      `<head> contient aucun CSS référence (inline/stylesheet/preload) → FOUC garanti. Head sample: ${head.slice(0, 500)}`,
    ).toBe(true);
  });
});
