/**
 * Lecture des credentials VoIP d'un tenant pour le sync des call logs.
 *
 * ─── Coordination U8 ────────────────────────────────────────────────────────
 *
 * Les credentials VoIP sont saisis par le tenant via la page Settings (U8) et
 * stockés dans la table `TenantCredential` (kind `voip_ovh` / `voip_telnyx`),
 * chiffrés AES-256-GCM. U8 possède :
 *   - le schéma des creds (`src/credentials/providers.ts` : OvhCreds / TelnyxCreds)
 *   - le chiffrement (`src/credentials/crypto.ts`)
 *   - le CRUD + l'endpoint "Tester" (`src/credentials/store.ts`, settings routes)
 *
 * B-VOIP ne duplique RIEN de tout ça : ce module est un simple adaptateur de
 * LECTURE qui déchiffre les `TenantCredential` de kind VoIP et expose une shape
 * stable (`LoadedVoipCredential`) au `sync.ts`. Pas de table de creds dédiée,
 * pas de chiffrement maison.
 *
 * Si U8 ajoute un provider VoIP, il suffit d'étendre `kindToProvider`.
 */

import type { PrismaClient } from "@prisma/client";
import {
  decryptJson,
  type EncryptedBlob,
} from "../credentials/crypto.js";
import {
  getProvider,
  type CredentialKind,
  type OvhCreds,
  type TelnyxCreds,
} from "../credentials/providers.js";

/** Provider VoIP normalisé tel que stocké dans `SipCall.provider`. */
export type VoipProvider = "ovh" | "telnyx";

/** kinds `TenantCredential` qui correspondent à un provider VoIP. */
const VOIP_KINDS: Record<string, VoipProvider> = {
  voip_ovh: "ovh",
  voip_telnyx: "telnyx",
};

/** Map provider VoIP → kind `TenantCredential`. */
export function providerToKind(provider: VoipProvider): CredentialKind {
  return (provider === "ovh" ? "voip_ovh" : "voip_telnyx") as CredentialKind;
}

/** Vrai si un `kind` `TenantCredential` est un provider VoIP. */
export function isVoipKind(kind: string): boolean {
  return kind in VOIP_KINDS;
}

/**
 * Un `TenantCredential` VoIP déchiffré, prêt pour le pull de CDR.
 * `data` est la shape provider-specific validée par U8 (`OvhCreds`/`TelnyxCreds`).
 */
export interface LoadedVoipCredential {
  /** id de la row `TenantCredential`. */
  id: string;
  tenantId: string;
  provider: VoipProvider;
  /** statut tel que tenu par U8 : 'untested' | 'ok' | 'failed'. */
  status: string;
  data: OvhCreds | TelnyxCreds;
}

/**
 * Charge et déchiffre TOUS les credentials VoIP d'un tenant.
 *
 * C'est l'interface stable consommée par `sync.ts`. Un tenant peut avoir
 * plusieurs providers branchés (OVH + Telnyx) — le sync les traite tous.
 *
 * Une row dont le blob est corrompu / illisible est ignorée silencieusement
 * (le déchiffrement est isolé par row — un cred KO ne bloque pas les autres).
 *
 * @param prisma        client Prisma
 * @param tenantId      id interne du Tenant (PK, pas le workspaceId)
 * @param encryptionKey clé hex AES-256-GCM (`TOKEN_ENCRYPTION_KEY`)
 */
export async function loadVoipCredentials(
  prisma: PrismaClient,
  tenantId: string,
  encryptionKey: string,
): Promise<LoadedVoipCredential[]> {
  const rows = await prisma.tenantCredential.findMany({
    where: { tenantId, kind: { in: Object.keys(VOIP_KINDS) } },
    orderBy: { kind: "asc" },
  });
  const out: LoadedVoipCredential[] = [];
  for (const row of rows) {
    const provider = VOIP_KINDS[row.kind];
    if (!provider) continue;
    let data: OvhCreds | TelnyxCreds;
    try {
      const clear = decryptJson(
        row.encryptedData as unknown as EncryptedBlob,
        encryptionKey,
      );
      // Re-valide via le provider U8 : garantit la shape avant le pull CDR.
      data = getProvider(row.kind).parse(clear) as OvhCreds | TelnyxCreds;
    } catch {
      // Blob corrompu ou clé invalide → on saute ce credential.
      continue;
    }
    out.push({
      id: row.id,
      tenantId: row.tenantId,
      provider,
      status: row.status,
      data,
    });
  }
  return out;
}

/**
 * Met à jour le statut + `lastSyncAt` / `lastError` d'un credential VoIP
 * après un sync. Écrit sur la table `TenantCredential` (U8).
 *
 * On ne touche PAS `lastTestedAt` (réservé au bouton "Tester" de U8).
 */
export async function markVoipSyncResult(
  prisma: PrismaClient,
  tenantId: string,
  provider: VoipProvider,
  outcome:
    | { ok: true; syncedAt: Date }
    | { ok: false; error: string },
): Promise<void> {
  await prisma.tenantCredential.updateMany({
    where: { tenantId, kind: providerToKind(provider) },
    data: outcome.ok
      ? { status: "ok", lastSyncAt: outcome.syncedAt, lastError: null }
      : { status: "failed", lastError: outcome.error },
  });
}
