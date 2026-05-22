/**
 * Tests unitaires — normalisation des numéros de téléphone (matching).
 *
 * Couvre `normalizePhone` de `src/voip/match.ts`. Le matching complet
 * `resolveVisitorIds` (qui touche Prisma) est couvert en intégration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../../src/voip/match.js";

test("normalizePhone: formats FR variés convergent vers les 9 derniers chiffres", () => {
  const expected = "612345678";
  assert.equal(normalizePhone("+33612345678"), expected);
  assert.equal(normalizePhone("0612345678"), expected);
  assert.equal(normalizePhone("0033612345678"), expected);
  assert.equal(normalizePhone("+33 6 12 34 56 78"), expected);
  assert.equal(normalizePhone("06.12.34.56.78"), expected);
  assert.equal(normalizePhone("(+33) 612-345-678"), expected);
});

test("normalizePhone: numéro vide ou null → chaîne vide", () => {
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(null), "");
  assert.equal(normalizePhone(undefined), "");
});

test("normalizePhone: numéro très court → renvoyé tel quel (chiffres only)", () => {
  assert.equal(normalizePhone("12345"), "12345");
  assert.equal(normalizePhone("ab12"), "12");
});

test("normalizePhone: deux numéros différents → résultats différents", () => {
  assert.notEqual(
    normalizePhone("+33611111111"),
    normalizePhone("+33622222222"),
  );
});
