/**
 * Couche DB des credentials self-service (U8).
 *
 * CRUD sur `TenantCredential` :
 *   - saveCredential   : valide + chiffre + upsert (un par (tenant, kind))
 *   - listCredentials  : liste MASQUÉE (jamais le clear-text)
 *   - testCredential   : déchiffre + appelle `provider.testConnection`,
 *                        met à jour `status` / `lastTestedAt` / `lastError`
 *   - deleteCredential : supprime
 *
 * Sécurité :
 *   - Les creds sont chiffrés AES-256-GCM (`src/credentials/crypto.ts`) avant
 *     écriture. Le clear-text n'existe JAMAIS en DB.
 *   - Aucune fonction de ce module ne renvoie le clear-text à l'appelant —
 *     `listCredentials` ne renvoie QUE des vues masquées.
 */

import type { PrismaClient } from "@prisma/client";
import { encryptJson, decryptJson, type EncryptedBlob } from "./crypto.js";
import {
  getProvider,
  isCredentialKind,
  type CredentialKind,
  type MaskedCredential,
} from "./providers.js";

export class CredentialError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "tenant_not_found"
      | "unknown_kind"
      | "invalid_creds"
      | "credential_not_found",
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

/** Vue d'un credential renvoyée par l'API — JAMAIS de secret en clair. */
export interface CredentialView {
  kind: CredentialKind;
  label: string;
  status: string;
  masked: MaskedCredential;
  lastSyncAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Valide la saisie via le provider, chiffre, et upsert.
 * `kind` doit être un `CredentialKind` connu ; `rawCreds` est la saisie brute
 * de l'utilisateur (validée par `provider.parse`).
 *
 * Le status repasse à `untested` à chaque écriture (les creds ont changé →
 * le dernier test est caduc).
 */
export async function saveCredential(
  prisma: PrismaClient,
  tenantId: string,
  kind: string,
  rawCreds: unknown,
  encryptionKey: string,
): Promise<CredentialView> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    throw new CredentialError(`tenant_not_found:${tenantId}`, "tenant_not_found");
  }
  if (!isCredentialKind(kind)) {
    throw new CredentialError(`unknown_credential_kind:${kind}`, "unknown_kind");
  }
  const provider = getProvider(kind);

  let parsed;
  try {
    parsed = provider.parse(rawCreds);
  } catch (err) {
    throw new CredentialError(
      `invalid_creds: ${(err as Error).message}`,
      "invalid_creds",
    );
  }

  const blob = encryptJson(
    parsed as unknown as Record<string, unknown>,
    encryptionKey,
  );

  const row = await prisma.tenantCredential.upsert({
    where: { tenantId_kind: { tenantId, kind } },
    update: {
      encryptedData: blob as unknown as object,
      status: "untested",
      lastError: null,
    },
    create: {
      tenantId,
      kind,
      encryptedData: blob as unknown as object,
      status: "untested",
    },
  });

  return toView(row, provider.mask(parsed), provider.label);
}

/**
 * Liste les credentials d'un tenant, MASQUÉS. Aucun secret en clair.
 */
export async function listCredentials(
  prisma: PrismaClient,
  tenantId: string,
  encryptionKey: string,
): Promise<CredentialView[]> {
  const rows = await prisma.tenantCredential.findMany({
    where: { tenantId },
    orderBy: { kind: "asc" },
  });
  return rows.map((row) => {
    const provider = getProvider(row.kind);
    // Déchiffre uniquement pour masquer — le clear-text ne quitte pas cette
    // fonction. Si le blob est corrompu, on dégrade en masque vide.
    let masked: MaskedCredential = {};
    try {
      const clear = decryptJson(
        row.encryptedData as unknown as EncryptedBlob,
        encryptionKey,
      );
      masked = provider.mask(provider.parse(clear));
    } catch {
      masked = { error: "•••• (déchiffrement impossible)" };
    }
    return toView(row, masked, provider.label);
  });
}

/**
 * Teste la connexion d'un credential : déchiffre, appelle le provider,
 * persiste le résultat (`status`, `lastTestedAt`, `lastError`).
 */
export async function testCredential(
  prisma: PrismaClient,
  tenantId: string,
  kind: string,
  encryptionKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string; status: string }> {
  if (!isCredentialKind(kind)) {
    throw new CredentialError(`unknown_credential_kind:${kind}`, "unknown_kind");
  }
  const row = await prisma.tenantCredential.findUnique({
    where: { tenantId_kind: { tenantId, kind } },
  });
  if (!row) {
    throw new CredentialError(
      `credential_not_found:${tenantId}:${kind}`,
      "credential_not_found",
    );
  }
  const provider = getProvider(kind);
  const clear = decryptJson(
    row.encryptedData as unknown as EncryptedBlob,
    encryptionKey,
  );
  const result = await provider.testConnection(
    provider.parse(clear) as never,
    fetchImpl,
  );
  const status = result.ok ? "ok" : "failed";
  await prisma.tenantCredential.update({
    where: { id: row.id },
    data: {
      status,
      lastTestedAt: new Date(),
      lastError: result.ok ? null : result.message,
    },
  });
  return { ok: result.ok, message: result.message, status };
}

/**
 * Supprime un credential. No-op silencieux si absent (idempotent).
 */
export async function deleteCredential(
  prisma: PrismaClient,
  tenantId: string,
  kind: string,
): Promise<{ deleted: boolean }> {
  if (!isCredentialKind(kind)) {
    throw new CredentialError(`unknown_credential_kind:${kind}`, "unknown_kind");
  }
  const row = await prisma.tenantCredential.findUnique({
    where: { tenantId_kind: { tenantId, kind } },
  });
  if (!row) return { deleted: false };
  await prisma.tenantCredential.delete({ where: { id: row.id } });
  return { deleted: true };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface CredentialRow {
  kind: string;
  status: string;
  lastSyncAt: Date | null;
  lastTestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toView(
  row: CredentialRow,
  masked: MaskedCredential,
  label: string,
): CredentialView {
  return {
    kind: row.kind as CredentialKind,
    label,
    status: row.status,
    masked,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
