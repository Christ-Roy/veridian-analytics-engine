/**
 * Sync des call logs VoIP → table `SipCall`.
 *
 * Pour un tenant :
 *   1. charge ses credentials VoIP (déchiffrés depuis `TenantCredential`, U8)
 *   2. pour chaque provider branché, pull les CDR via le client provider
 *   3. matche les `visitorId` (appel inbound depuis un clic `tel:` tracké)
 *   4. upsert idempotent dans `SipCall` (clé `@@unique(provider, externalId)`)
 *   5. met à jour le statut + `lastSyncAt` du `TenantCredential`
 *
 * Idempotence : un re-sync ne duplique jamais — `upsert` sur la clé unique
 * `(provider, externalId)`. Les valeurs (durée, statut, recordingUrl,
 * visitorId) sont rafraîchies à chaque sync.
 *
 * Fail-soft : un provider qui échoue n'empêche pas les autres de syncer ;
 * l'erreur est capturée dans le résultat et le credential passe en `failed`.
 */

import type { PrismaClient } from "@prisma/client";
import type { OvhCreds, TelnyxCreds } from "../credentials/providers.js";
import {
  loadVoipCredentials,
  markVoipSyncResult,
  type LoadedVoipCredential,
  type VoipProvider,
} from "./credentials.js";
import { fetchOvhCdr } from "./providers/ovh.js";
import { fetchTelnyxCdr } from "./providers/telnyx.js";
import { resolveVisitorIds } from "./match.js";
import { VoipApiError, type NormalizedCall } from "./types.js";

/** Fenêtre de sync par défaut : 30 jours en arrière. */
const DEFAULT_SYNC_DAYS = 30;

/**
 * URL staminads pour pousser les événements `phone_call`. Override via
 * `STAMINADS_URL` (déjà set côté infra bridge). Le format de payload
 * correspond à `POST /api/track` (cf `api/src/events/dto/session-payload.dto.ts`).
 *
 * Robert (sprint UI-NATIVE-PURE, 2026-05-23) : les appels VoIP ne vivent
 * PAS dans une page custom — ce sont des événements staminads natifs qui
 * apparaissent automatiquement dans Live, Explore, Goals. Le sync VoIP
 * pousse donc chaque appel synchronisé comme un event `goal` custom.
 */
const STAMINADS_URL = process.env.STAMINADS_URL ?? "http://staminads:3000";

/** Résultat du sync d'un provider pour un tenant. */
export interface ProviderSyncResult {
  provider: VoipProvider;
  fetched: number;
  upserted: number;
  matched: number;
  /** Événements `phone_call` poussés vers staminads (best-effort). */
  staminadsPushed: number;
  staminadsFailed: number;
  error: string | null;
}

/** Résultat global du sync d'un tenant. */
export interface SyncCallLogsResult {
  tenantId: string;
  workspaceId: string;
  providers: ProviderSyncResult[];
  totalUpserted: number;
}

export interface SyncCallLogsOptions {
  /** profondeur de la fenêtre de pull, en jours (défaut 30). */
  days?: number;
  /** clé hex AES-256-GCM (`TOKEN_ENCRYPTION_KEY`). */
  encryptionKey: string;
  /** injection de fetch pour les tests. */
  fetchImpl?: typeof fetch;
  /** horloge injectable (tests). */
  now?: () => Date;
}

/** Pull les CDR d'un credential donné via le bon client provider. */
async function fetchCdrForCredential(
  cred: LoadedVoipCredential,
  since: Date,
  until: Date,
  fetchImpl: typeof fetch,
): Promise<NormalizedCall[]> {
  if (cred.provider === "ovh") {
    return fetchOvhCdr(cred.data as OvhCreds, { since, until, fetchImpl });
  }
  if (cred.provider === "telnyx") {
    return fetchTelnyxCdr(cred.data as TelnyxCreds, { since, until, fetchImpl });
  }
  throw new VoipApiError(
    `unknown_provider: ${cred.provider}`,
    400,
    cred.provider as "ovh" | "telnyx",
  );
}

/**
 * Upsert idempotent d'un lot d'appels normalisés dans `SipCall`.
 *
 * `upsert` sur `(provider, externalId)` : create si nouveau, update sinon.
 * Retourne le nombre de rows traitées (créées ou mises à jour).
 */
async function upsertCalls(
  prisma: PrismaClient,
  tenantId: string,
  provider: VoipProvider,
  calls: NormalizedCall[],
  visitorIds: Map<string, string>,
): Promise<number> {
  let count = 0;
  for (const call of calls) {
    const visitorId = visitorIds.get(call.externalId) ?? null;
    await prisma.sipCall.upsert({
      where: {
        provider_externalId: { provider, externalId: call.externalId },
      },
      update: {
        tenantId,
        direction: call.direction,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        durationSec: call.durationSec,
        status: call.status,
        recordingUrl: call.recordingUrl,
        startedAt: call.startedAt,
        visitorId,
      },
      create: {
        tenantId,
        provider,
        externalId: call.externalId,
        direction: call.direction,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        durationSec: call.durationSec,
        status: call.status,
        recordingUrl: call.recordingUrl,
        startedAt: call.startedAt,
        visitorId,
      },
    });
    count++;
  }
  return count;
}

/**
 * Pousse chaque appel synchronisé comme événement `phone_call` dans staminads
 * via `POST /api/track`. Fail-soft : un échec staminads n'invalide PAS le
 * sync (les appels restent en DB bridge, on retentera au prochain cron).
 *
 * Format payload : un session minimal avec un seul `goal` action portant
 * `name: 'phone_call'` et properties (direction, duration_sec, status,
 * from_number, to_number). Le `session_id` est dérivé du `externalId` de
 * l'appel pour idempotence (staminads dédup par dedup_token côté serveur).
 *
 * Pourquoi `goal` et pas un type custom : le DTO `SessionPayloadDto` n'accepte
 * que `pageview` et `goal` côté staminads natif — `goal` permet de porter
 * un `name` arbitraire (`phone_call`) + `properties`, donc c'est le bon
 * canal pour les événements externes type VoIP.
 */
async function pushStaminadsEvents(
  workspaceId: string,
  provider: VoipProvider,
  calls: NormalizedCall[],
  visitorIds: Map<string, string>,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<{ ok: number; failed: number }> {
  const nowMs = now.getTime();
  let ok = 0;
  let failed = 0;
  for (const call of calls) {
    const visitorId = visitorIds.get(call.externalId) ?? null;
    const startedAtMs = call.startedAt.getTime();
    const goalTs = startedAtMs;
    const sessionId = `voip:${provider}:${call.externalId}`;
    const payload = {
      workspace_id: workspaceId,
      session_id: sessionId,
      created_at: startedAtMs,
      updated_at: nowMs,
      sent_at: nowMs,
      user_id: visitorId,
      actions: [
        {
          type: "goal",
          name: "phone_call",
          path: "/voip",
          page_number: 1,
          timestamp: goalTs,
          value: call.durationSec,
          properties: {
            direction: call.direction,
            duration_sec: String(call.durationSec),
            status: call.status,
            from_number: call.fromNumber,
            to_number: call.toNumber,
            provider,
            external_id: call.externalId,
          },
        },
      ],
      attributes: {
        landing_page: "/voip",
        referrer: `voip://${provider}`,
      },
    };
    try {
      const res = await fetchImpl(`${STAMINADS_URL}/api/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        ok++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}

/**
 * Sync les call logs d'un SEUL tenant (tous ses providers VoIP branchés).
 *
 * @param prisma   client Prisma
 * @param tenantId id interne du Tenant (PK)
 */
export async function syncCallLogs(
  prisma: PrismaClient,
  tenantId: string,
  opts: SyncCallLogsOptions,
): Promise<SyncCallLogsResult> {
  const days = opts.days && opts.days > 0 ? opts.days : DEFAULT_SYNC_DAYS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ? opts.now() : new Date();
  const since = new Date(now.getTime() - days * 86400000);

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, workspaceId: true },
  });
  if (!tenant) {
    throw new VoipApiError(`tenant_not_found: ${tenantId}`, 404, "telnyx");
  }

  const creds = await loadVoipCredentials(prisma, tenantId, opts.encryptionKey);
  const result: SyncCallLogsResult = {
    tenantId,
    workspaceId: tenant.workspaceId,
    providers: [],
    totalUpserted: 0,
  };

  for (const cred of creds) {
    const pr: ProviderSyncResult = {
      provider: cred.provider,
      fetched: 0,
      upserted: 0,
      matched: 0,
      staminadsPushed: 0,
      staminadsFailed: 0,
      error: null,
    };
    try {
      const calls = await fetchCdrForCredential(cred, since, now, fetchImpl);
      pr.fetched = calls.length;

      const visitorIds = await resolveVisitorIds(prisma, tenantId, calls);
      pr.matched = visitorIds.size;

      pr.upserted = await upsertCalls(
        prisma,
        tenantId,
        cred.provider,
        calls,
        visitorIds,
      );
      result.totalUpserted += pr.upserted;

      // Push événements `phone_call` → staminads /api/track (best-effort).
      // Pas de throw si staminads est down : on n'invalide pas le sync DB.
      if (calls.length > 0 && tenant.workspaceId) {
        const pushResult = await pushStaminadsEvents(
          tenant.workspaceId,
          cred.provider,
          calls,
          visitorIds,
          fetchImpl,
          now,
        );
        pr.staminadsPushed = pushResult.ok;
        pr.staminadsFailed = pushResult.failed;
      }

      await markVoipSyncResult(prisma, tenantId, cred.provider, {
        ok: true,
        syncedAt: now,
      });
    } catch (err) {
      const msg =
        err instanceof VoipApiError
          ? `[${err.status}] ${err.message}`
          : err instanceof Error
            ? err.message
            : "unknown_error";
      pr.error = msg;
      await markVoipSyncResult(prisma, tenantId, cred.provider, {
        ok: false,
        error: msg,
      });
    }
    result.providers.push(pr);
  }

  return result;
}

/**
 * Sync les call logs de TOUS les tenants ayant au moins un `TenantCredential`
 * VoIP dont le statut n'est pas `failed` (un cred déjà cassé ne sera pas
 * re-tenté en boucle par le cron — il faut le re-tester via le bouton
 * "Tester" de la page Settings).
 *
 * Un tenant qui échoue n'interrompt pas les autres.
 */
export async function syncAllCallLogs(
  prisma: PrismaClient,
  opts: SyncCallLogsOptions,
): Promise<SyncCallLogsResult[]> {
  // Tenants distincts ayant un credential VoIP exploitable.
  const creds = await prisma.tenantCredential.findMany({
    where: {
      kind: { in: ["voip_ovh", "voip_telnyx"] },
      status: { in: ["ok", "untested"] },
    },
    select: { tenantId: true },
  });
  const tenantIds = [...new Set(creds.map((c) => c.tenantId))];

  const out: SyncCallLogsResult[] = [];
  for (const tenantId of tenantIds) {
    try {
      out.push(await syncCallLogs(prisma, tenantId, opts));
    } catch (err) {
      out.push({
        tenantId,
        workspaceId: "",
        providers: [
          {
            provider: "telnyx",
            fetched: 0,
            upserted: 0,
            matched: 0,
            staminadsPushed: 0,
            staminadsFailed: 0,
            error: err instanceof Error ? err.message : "unknown_error",
          },
        ],
        totalUpserted: 0,
      });
    }
  }
  return out;
}
