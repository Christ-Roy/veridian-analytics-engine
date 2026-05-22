/**
 * Chiffrement AES-256-GCM générique pour les credentials self-service (U8).
 *
 * Même algorithme et même format de blob que `src/gsc/oauth.ts`
 * (`encryptTokens`/`decryptTokens`), mais générique : chiffre n'importe quel
 * objet JSON-sérialisable, pas seulement des `OauthTokens`.
 *
 * Clé : `TOKEN_ENCRYPTION_KEY` (32 bytes = 64 hex chars), partagée avec GSC.
 * On réutilise volontairement la MÊME variable d'env : un seul secret de
 * chiffrement at-rest pour tout le bridge (GSC tokens + VoIP creds).
 *
 * Format du blob stocké en DB (colonne `TenantCredential.encryptedData`) :
 *   { v: 1, iv: "<hex>", tag: "<hex>", ciphertext: "<hex>" }
 *
 * Le clear-text n'existe JAMAIS en DB. L'API ne renvoie JAMAIS le clear-text :
 * elle ne sert que des vues masquées (cf `maskCredential`).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedBlob {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

/** Valide qu'une clé hex fait bien 32 bytes (64 hex chars). Retourne le Buffer. */
function keyBuffer(hexKey: string): Buffer {
  if (hexKey.length !== 64 || !/^[0-9a-f]+$/i.test(hexKey)) {
    throw new CredentialCryptoError(
      "TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate via: openssl rand -hex 32",
    );
  }
  return Buffer.from(hexKey, "hex");
}

/**
 * Chiffre un objet JSON-sérialisable en blob AES-256-GCM.
 */
export function encryptJson(
  data: Record<string, unknown>,
  hexKey: string,
): EncryptedBlob {
  const key = keyBuffer(hexKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: enc.toString("hex"),
  };
}

/**
 * Déchiffre un blob AES-256-GCM. Throw si la clé est mauvaise ou le blob
 * altéré (le tag GCM authentifie le ciphertext).
 */
export function decryptJson<T = Record<string, unknown>>(
  blob: EncryptedBlob,
  hexKey: string,
): T {
  const key = keyBuffer(hexKey);
  if (!blob || blob.v !== 1 || !blob.iv || !blob.tag || !blob.ciphertext) {
    throw new CredentialCryptoError("invalid_encrypted_blob");
  }
  const iv = Buffer.from(blob.iv, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ct = Buffer.from(blob.ciphertext, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as T;
}

/**
 * Lit `TOKEN_ENCRYPTION_KEY` depuis l'env. Throw `CredentialCryptoError`
 * si absente ou mal formée.
 */
export function readEncryptionKeyFromEnv(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new CredentialCryptoError(
      "TOKEN_ENCRYPTION_KEY missing — credentials feature disabled",
    );
  }
  // Valide le format en construisant le buffer (throw si KO).
  keyBuffer(key);
  return key;
}
