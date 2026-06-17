/**
 * Normalisation E.164 pure pour la dimension `source` des events `phone_call`.
 *
 * Port direct de `veridian-bridge/src/voip/phone-numbers.ts:toE164` (logique
 * pure, sans dépendance DB). Le lookup `(workspace, e164)→source` vit dans
 * `voip-numbers.service.ts` (accès ClickHouse).
 *
 * Vision Robert 2026-05-25 : 1 numéro par source de trafic. Le sync enrichit
 * chaque event `phone_call` avec `properties.source` après lookup du `toNumber`
 * normalisé. Pas trouvé → `direct` (default safe).
 */

/**
 * Normalise un numéro vers le format E.164 (`+33177...`).
 *
 * Règles (volontairement conservatrices — on stocke EXACTEMENT ce que les
 * providers renvoient quand c'est déjà bien formé, on corrige juste les
 * formats français évidents) :
 *
 *   1. Si déjà `+<digits>` → retourner tel quel (trim + suppression espaces).
 *   2. Si commence par `00` → remplacer par `+` (préfixe international).
 *   3. Si 10 chiffres et commence par `0` (format FR national) →
 *      remplacer le `0` par `+33`.
 *   4. Si 9 chiffres FR sans 0 initial → `+33` + chiffres.
 *   5. Sinon → `null` (numéro non normalisable, lookup échouera = `direct`).
 *
 * Telnyx renvoie déjà du E.164. OVH `voiceConsumption` renvoie en général le
 * format national (`01...`) côté FR — on remappe.
 *
 * Note : pas de lib externe (`libphonenumber-js` = 200kb). Pour 7 sources et
 * un usage France-only V1, cette normalisation suffit.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s.\-()]/g, '').trim();
  if (cleaned.length === 0) return null;

  // Déjà E.164
  if (/^\+\d{6,15}$/.test(cleaned)) return cleaned;

  // 00<digits> → +<digits>
  if (/^00\d{6,15}$/.test(cleaned)) return '+' + cleaned.slice(2);

  // 10 chiffres commençant par 0 (FR national)
  if (/^0\d{9}$/.test(cleaned)) return '+33' + cleaned.slice(1);

  // 9 chiffres FR sans 0 initial (peut arriver si provider trim)
  if (/^[1-9]\d{8}$/.test(cleaned)) return '+33' + cleaned;

  return null;
}
