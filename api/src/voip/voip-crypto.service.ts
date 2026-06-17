import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { encrypt, decrypt, deriveKey } from '../common/crypto';

/**
 * Chiffrement des credentials VoIP au repos — clé dérivée PAR workspace.
 *
 * Réutilise `common/crypto.ts` (AES-256-GCM, `deriveKey` = PBKDF2-SHA256 sur
 * (masterKey, workspaceId)) — le même primitif que les autres secrets
 * tenant de l'engine (`encryptApiKey`, `encryptPassword`). Le master key vient
 * de `VOIP_ENCRYPTION_KEY`, avec fallback `ENCRYPTION_KEY` pour que les
 * installs existants marchent sans nouvelle ENV (même stratégie que
 * `WebhookCrypto`).
 *
 * Clé PAR workspace (≠ WebhookCrypto qui a une clé globale) : un dump d'un
 * cred d'un tenant ne donne rien sur les autres. Format on disk :
 * "iv_hex:authTag_hex:ciphertext_hex" (cf `common/crypto.encrypt`).
 */
@Injectable()
export class VoipCrypto {
  private readonly masterKey: string;

  constructor(private readonly config: ConfigService) {
    const voipKey = this.config.get<string>('VOIP_ENCRYPTION_KEY');
    const fallback = this.config.get<string>('ENCRYPTION_KEY') ?? '';
    const source = voipKey && voipKey.length > 0 ? voipKey : fallback;
    if (!source || source.length < 32) {
      throw new InternalServerErrorException(
        'VoipCrypto: no encryption key available (set VOIP_ENCRYPTION_KEY or ENCRYPTION_KEY ≥ 32 chars).',
      );
    }
    this.masterKey = source;
  }

  /** Chiffre les creds en clair (JSON sérialisé) pour un workspace donné. */
  encryptCreds(plaintext: string, workspaceId: string): string {
    if (plaintext === '') return '';
    const key = deriveKey(this.masterKey, workspaceId);
    return encrypt(plaintext, key);
  }

  /** Déchiffre les creds d'un workspace. Throw si tampering / format invalide. */
  decryptCreds(payload: string, workspaceId: string): string {
    if (payload === '') return '';
    const key = deriveKey(this.masterKey, workspaceId);
    return decrypt(payload, key);
  }
}
