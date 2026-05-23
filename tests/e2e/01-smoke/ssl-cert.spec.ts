/**
 * 01-smoke — SSL certificate.
 *
 * Vérifie que :
 *   - Issuer = Let's Encrypt (R10/R11/R12/R13 ou E5/E6)
 *   - Cert valide ≥ 7 jours (warn manager AVANT que ça pète)
 *   - Cert subject correspond au hostname
 *
 * Si le cert expire dans < 7 jours, le test fail et un agent doit
 * forcer un renewal Traefik.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { getCertInfo } from "../helpers/ssl";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`SSL certificate [${TARGET}]`, () => {
  test(`cert valide pour ${target.hostname}`, async () => {
    const info = await getCertInfo(target.hostname);
    expect(info.isLetsEncrypt, `issuer=${info.issuer}`).toBe(true);
    expect(
      info.daysUntilExpiry,
      `expires in ${info.daysUntilExpiry} days`,
    ).toBeGreaterThanOrEqual(7);
  });

  // Si le bridge est sur un sous-domaine distinct (cas staging/prod), on vérif
  // aussi son cert.
  test(`cert valide pour bridge`, async () => {
    test.skip(target.isDemo, "Demo n'a pas de bridge séparé");
    const bridgeHost = new URL(target.bridgeUrl).hostname;
    if (bridgeHost === target.hostname) {
      test.skip(true, "Bridge même host que console — déjà testé");
    }
    const info = await getCertInfo(bridgeHost);
    expect(info.isLetsEncrypt, `issuer=${info.issuer}`).toBe(true);
    expect(info.daysUntilExpiry).toBeGreaterThanOrEqual(7);
  });
});
