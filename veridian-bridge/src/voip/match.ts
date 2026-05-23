/**
 * Matching d'un appel téléphonique → session web (visitorId).
 *
 * Historique : ce match passait par la table `Lead` (siteId, phone) +
 * `LeadSession` (visitorId) pour relier phone → visitorId. Les tables Lead /
 * LeadSession ont été retirées du périmètre 2026-05-23 (scope change Robert,
 * cleanup veridian-scope). Le matching téléphone → visitor est donc désactivé :
 *   - tous les appels sont enregistrés sans visitorId
 *   - si on veut le relier au futur, repartir du tracker `tel:` (visitorId
 *     posé directement par le tracker au moment du clic, sans table Lead)
 *
 * Cette fonction reste exportée avec la même signature pour ne pas casser
 * les callers (sync.ts) — elle retourne simplement une map vide.
 */

import type { PrismaClient } from "@prisma/client";
import type { NormalizedCall } from "./types.js";

/**
 * Normalise un numéro pour la comparaison : ne garde que les chiffres et
 * retient les 9 derniers (numéro national FR sans indicatif/0). Deux numéros
 * notés différemment (`+33612345678`, `0612345678`, `0033 6 12 34 56 78`)
 * convergent vers `612345678`.
 *
 * Gardé en export pour les tests existants — toujours utile si on rebranche
 * un matching basé sur les hits `tel:` côté tracker plus tard.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 6) return digits;
  return digits.slice(-9);
}

/**
 * No-op depuis 2026-05-23 (tables Lead/LeadSession supprimées).
 * Retourne toujours une map vide — pas de matching tenté.
 */
export async function resolveVisitorIds(
  _prisma: PrismaClient,
  _tenantId: string,
  _calls: NormalizedCall[],
): Promise<Map<string, string>> {
  return new Map();
}
