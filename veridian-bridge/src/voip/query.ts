/**
 * Lecture des call logs pour le tab Calls du dashboard (B-VOIP).
 *
 * Sert depuis la table `SipCall` — pas d'appel provider en lecture.
 *
 * ─── Contrat cross-ticket avec U9 ───────────────────────────────────────────
 *
 * La shape de retour (`CallsSummary`) DOIT respecter le contrat `CallsResponse`
 * défini côté console U9 (`console/src/veridian/api.ts`). En particulier :
 *   - `voipConnected` : false si le tenant n'a aucun `TenantCredential` VoIP
 *     → l'UI affiche un onboarding "Connectez votre téléphonie", pas une erreur.
 *   - `calls[].peerNumber` : numéro de l'interlocuteur distant (le client) —
 *     `fromNumber` pour un inbound, `toNumber` pour un outbound.
 *   - `stats` : agrégats calculés côté serveur (total, missed, avgDurationSec,
 *     answerRate).
 *   - `daily` : série journalière pour le graphe appels/jour.
 */

import type { PrismaClient } from "@prisma/client";

/** Un appel tel que consommé par le tab Calls — contrat U9 `CallRecord`. */
export interface CallRow {
  id: string;
  /** ISO 8601 — début de l'appel. */
  startedAt: string;
  direction: string;
  /** numéro de l'interlocuteur distant (le client). */
  peerNumber: string;
  /** durée en secondes ; 0 pour un appel non décroché. */
  durationSec: number;
  status: string;
  /** URL de l'enregistrement audio, si disponible. */
  recordingUrl: string | null;
}

/** Une entrée de la série journalière (graphe appels/jour). */
export interface DailyPoint {
  /** jour au format `YYYY-MM-DD` (UTC). */
  day: string;
  total: number;
  missed: number;
}

/** Réponse du tab Calls — contrat U9 `CallsResponse`. */
export interface CallsSummary {
  /** false si aucun `TenantCredential` VoIP n'est branché pour ce tenant. */
  voipConnected: boolean;
  calls: CallRow[];
  stats: {
    total: number;
    missed: number;
    /** durée moyenne en secondes — appels répondus uniquement. */
    avgDurationSec: number;
    /** taux de réponse 0..1 (répondus / total). */
    answerRate: number;
  };
  /** série journalière, du plus ancien au plus récent. */
  daily: DailyPoint[];
}

/** Le numéro de l'interlocuteur distant selon la direction de l'appel. */
function peerNumber(direction: string, from: string, to: string): string {
  return direction === "outbound" ? to : from;
}

/** Clé jour UTC `YYYY-MM-DD` d'une date. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Liste les appels d'un tenant sur les `days` derniers jours.
 *
 * @param prisma      client Prisma
 * @param workspaceId workspaceId staminads du tenant (identifiant public)
 * @param days        fenêtre en jours (défaut 30, plafonné à 365)
 * @param limit       nombre max d'appels retournés (défaut 200, plafonné 1000)
 * @returns `null` si le tenant n'existe pas (→ 404 côté route).
 */
export async function listCalls(
  prisma: PrismaClient,
  opts: { workspaceId: string; days?: number; limit?: number },
): Promise<CallsSummary | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { workspaceId: opts.workspaceId },
    select: { id: true },
  });
  if (!tenant) return null;

  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const since = new Date(Date.now() - days * 86400000);

  // `voipConnected` : le tenant a-t-il branché un provider VoIP ?
  const voipCredCount = await prisma.tenantCredential.count({
    where: { tenantId: tenant.id, kind: { in: ["voip_ovh", "voip_telnyx"] } },
  });
  const voipConnected = voipCredCount > 0;

  const rows = await prisma.sipCall.findMany({
    where: { tenantId: tenant.id, startedAt: { gte: since } },
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  // Stats agrégées sur le lot retourné.
  let missed = 0;
  let answeredCount = 0;
  let answeredDurationSec = 0;
  // Série journalière : initialisée à 0 pour chaque jour de la fenêtre.
  const dailyMap = new Map<string, { total: number; missed: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    dailyMap.set(dayKey(d), { total: 0, missed: 0 });
  }

  for (const r of rows) {
    const isAnswered = r.status === "answered";
    if (isAnswered) {
      answeredCount++;
      answeredDurationSec += r.durationSec;
    } else {
      missed++;
    }
    const key = dayKey(r.startedAt);
    const bucket = dailyMap.get(key);
    if (bucket) {
      bucket.total++;
      if (!isAnswered) bucket.missed++;
    }
  }

  const total = rows.length;
  const daily: DailyPoint[] = [...dailyMap.entries()]
    .map(([day, v]) => ({ day, total: v.total, missed: v.missed }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    voipConnected,
    calls: rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      direction: r.direction,
      peerNumber: peerNumber(r.direction, r.fromNumber, r.toNumber),
      durationSec: r.durationSec,
      status: r.status,
      recordingUrl: r.recordingUrl,
    })),
    stats: {
      total,
      missed,
      avgDurationSec:
        answeredCount > 0
          ? Math.round(answeredDurationSec / answeredCount)
          : 0,
      answerRate: total > 0 ? answeredCount / total : 0,
    },
    daily,
  };
}
