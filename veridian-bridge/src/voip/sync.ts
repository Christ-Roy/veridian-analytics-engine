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

/** Résultat du sync d'un provider pour un tenant. */
export interface ProviderSyncResult {
  provider: VoipProvider;
  fetched: number;
  upserted: number;
  matched: number;
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
            error: err instanceof Error ? err.message : "unknown_error",
          },
        ],
        totalUpserted: 0,
      });
    }
  }
  return out;
}
