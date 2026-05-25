/**
 * TenantPhoneNumber — CRUD + lookup pour la dimension `source` des events
 * `phone_call` (2026-05-25).
 *
 * Vision Robert 2026-05-25 : 1 numéro par source de trafic (SEO / Ads /
 * direct / email / social / print / other). Le bridge enrichit chaque event
 * `phone_call` poussé vers staminads avec `properties.source = <source>` en
 * faisant un lookup `(tenantId, e164 = toNumber)` après normalisation E.164.
 *
 * Pas trouvé → `direct` (default safe). Les appels apparaissent dans
 * Live/Explore/Goals staminads, automatiquement filtrables par dimension
 * `source` — pas de page custom côté UI.
 *
 * Module isolé : aucun import du sync, pour pouvoir être consommé par les
 * routes admin sans dépendance circulaire.
 */

import type { PrismaClient, PhoneNumberSource } from "@prisma/client";

/** Valeurs autorisées pour la dimension `source` (mirror Prisma enum). */
export const PHONE_NUMBER_SOURCES = [
  "seo",
  "ads",
  "direct",
  "email",
  "social",
  "print",
  "other",
] as const;

export type PhoneSource = (typeof PHONE_NUMBER_SOURCES)[number];

export function isPhoneSource(v: unknown): v is PhoneSource {
  return typeof v === "string" && (PHONE_NUMBER_SOURCES as readonly string[]).includes(v);
}

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
 *   4. Sinon → `null` (numéro non normalisable, lookup échouera = `direct`).
 *
 * Telnyx renvoie déjà du E.164. OVH `voiceConsumption` renvoie en général le
 * format national (`01...`) côté FR — on remappe.
 *
 * Note : pas de lib externe (`libphonenumber-js` = 200kb). Pour 7 sources et
 * un usage France-only V1, cette normalisation suffit. Si on internationalise,
 * on swappera vers libphonenumber.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s.\-()]/g, "").trim();
  if (cleaned.length === 0) return null;

  // Déjà E.164
  if (/^\+\d{6,15}$/.test(cleaned)) return cleaned;

  // 00<digits> → +<digits>
  if (/^00\d{6,15}$/.test(cleaned)) return "+" + cleaned.slice(2);

  // 10 chiffres commençant par 0 (FR national)
  if (/^0\d{9}$/.test(cleaned)) return "+33" + cleaned.slice(1);

  // 9 chiffres FR sans 0 initial (peut arriver si provider trim)
  if (/^[1-9]\d{8}$/.test(cleaned)) return "+33" + cleaned;

  return null;
}

/**
 * Lookup le mapping `(tenantId, toNumber) → source` pour un lot d'appels.
 *
 * Optimisation : on extrait tous les `toNumber` distincts, on les normalise,
 * on fait UNE seule query Prisma `IN (...)`, et on retourne une Map<e164, row>.
 * Le caller (sync.ts) itère sur les calls et matche `toE164(call.toNumber)`.
 *
 * Returns une Map vide si aucun numéro normalisable / aucun mapping en DB.
 */
export interface TrackedNumberLookup {
  id: string;
  e164: string;
  source: PhoneNumberSource;
  label: string | null;
}

export async function lookupTrackedNumbers(
  prisma: PrismaClient,
  tenantId: string,
  toNumbers: string[],
): Promise<Map<string, TrackedNumberLookup>> {
  const normalized = new Set<string>();
  for (const raw of toNumbers) {
    const e164 = toE164(raw);
    if (e164) normalized.add(e164);
  }
  if (normalized.size === 0) return new Map();

  const rows = await prisma.tenantPhoneNumber.findMany({
    where: { tenantId, e164: { in: [...normalized] } },
    select: { id: true, e164: true, source: true, label: true },
  });

  const map = new Map<string, TrackedNumberLookup>();
  for (const r of rows) map.set(r.e164, r);
  return map;
}
