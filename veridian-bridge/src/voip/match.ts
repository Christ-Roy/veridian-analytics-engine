/**
 * Matching d'un appel téléphonique → session web (visitorId).
 *
 * Quand un visiteur clique un lien `tel:` tracké sur le site, le tracker
 * Veridian crée une session web identifiée par un `visitorId` (cookie
 * `vrd_vid`). Si ce visiteur passe ensuite l'appel, on veut relier le SipCall
 * à sa session web — pour mesurer "cette page a généré cet appel".
 *
 * Le bridge n'a pas accès aux pageviews staminads (ClickHouse) ici : le signal
 * fiable et local est le numéro de téléphone. Quand un Lead Veridian a été
 * créé (formulaire avec champ `phone`), on connaît la correspondance
 * `phone → visitorId` via la chaîne `Lead.phone` → `LeadSession.visitorId`.
 *
 * Stratégie de match (appel INBOUND uniquement — c'est le visiteur qui appelle) :
 *   1. normaliser le numéro appelant en E.164 (derniers chiffres significatifs)
 *   2. chercher un `Lead` du tenant dont `phone` normalisé == numéro appelant
 *   3. prendre la `LeadSession` la plus récente de ce Lead qui a un `visitorId`
 *
 * Pas de match → `visitorId` reste `null` (l'appel est quand même enregistré).
 */

import type { PrismaClient } from "@prisma/client";
import type { NormalizedCall } from "./types.js";

/**
 * Normalise un numéro pour la comparaison : ne garde que les chiffres et
 * retient les 9 derniers (numéro national FR sans indicatif/0). Deux numéros
 * notés différemment (`+33612345678`, `0612345678`, `0033 6 12 34 56 78`)
 * convergent vers `612345678`.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 6) return digits;
  return digits.slice(-9);
}

/**
 * Pour un ensemble d'appels d'un tenant, résout les `visitorId` matchés.
 *
 * Retourne une `Map<externalId, visitorId>` — seules les entrées matchées y
 * figurent. Implémentation : une seule passe DB sur les Leads téléphonés du
 * tenant, puis matching en mémoire (pas de N+1).
 *
 * @param prisma   client Prisma
 * @param tenantId id interne du Tenant
 * @param calls    appels normalisés (inbound + outbound — on matche inbound)
 */
export async function resolveVisitorIds(
  prisma: PrismaClient,
  tenantId: string,
  calls: NormalizedCall[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (calls.length === 0) return result;

  // On ne matche que les appels entrants : un appel sortant part de Veridian,
  // pas d'un visiteur. Le numéro appelant d'un inbound = numéro du visiteur.
  const inbound = calls.filter((c) => c.direction === "inbound");
  if (inbound.length === 0) return result;

  // Tous les Leads du tenant qui ont un numéro de téléphone, avec leur
  // session la plus récente portant un visitorId.
  const leads = await prisma.lead.findMany({
    where: {
      site: { tenantId },
      phone: { not: null },
    },
    select: {
      phone: true,
      sessions: {
        where: { visitorId: { not: null } },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { visitorId: true },
      },
    },
  });

  // Index phone normalisé → visitorId (le plus récent gagne).
  const phoneToVisitor = new Map<string, string>();
  for (const lead of leads) {
    const norm = normalizePhone(lead.phone);
    if (!norm) continue;
    const vid = lead.sessions[0]?.visitorId;
    if (vid && !phoneToVisitor.has(norm)) {
      phoneToVisitor.set(norm, vid);
    }
  }
  if (phoneToVisitor.size === 0) return result;

  for (const call of inbound) {
    const norm = normalizePhone(call.fromNumber);
    if (!norm) continue;
    const vid = phoneToVisitor.get(norm);
    if (vid) result.set(call.externalId, vid);
  }
  return result;
}
