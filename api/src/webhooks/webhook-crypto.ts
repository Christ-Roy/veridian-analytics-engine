import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommends 12 bytes
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

/**
 * Webhook secret encryption — cf PATTERNS-WEBHOOKS.md §8.
 *
 * Encrypts the workspace-supplied Bearer / Basic / HMAC secret at rest in
 * `webhook_definitions.auth_secret`. AES-256-GCM with a master key sourced
 * from `WEBHOOK_ENCRYPTION_KEY` (falls back to `ENCRYPTION_KEY` so fresh
 * installs work out of the box).
 *
 * Format on disk: "iv_hex:authTag_hex:ciphertext_hex".
 *
 * Key rotation is not in scope for Phase 1 — Phase 2 ticket.
 */
@Injectable()
export class WebhookCrypto {
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    const webhookKey = this.config.get<string>('WEBHOOK_ENCRYPTION_KEY');
    const fallback = this.config.get<string>('ENCRYPTION_KEY') ?? '';
    const source = webhookKey && webhookKey.length > 0 ? webhookKey : fallback;
    if (!source || source.length < 32) {
      // Use a deterministic SHA-256 derivation so the key is always 32 bytes,
      // even if the operator supplied a longer plain string. This still
      // requires the ConfigModule to have refused short ENCRYPTION_KEYs.
      throw new InternalServerErrorException(
        'WebhookCrypto: no encryption key available (set WEBHOOK_ENCRYPTION_KEY or ENCRYPTION_KEY ≥ 32 chars).',
      );
    }
    this.key = createHash('sha256').update(source).digest().subarray(0, KEY_LENGTH);
  }

  /**
   * Encrypt a plaintext secret. Returns the canonical
   * "iv_hex:authTag_hex:ciphertext_hex" form.
   */
  encryptSecret(plaintext: string): string {
    if (plaintext === '') return '';
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  /**
   * Decrypt a secret previously produced by encryptSecret.
   * Throws on tampering / malformed input (GCM auth-tag check fails).
   */
  decryptSecret(payload: string): string {
    if (payload === '') return '';
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new InternalServerErrorException(
        'WebhookCrypto.decrypt: invalid payload format',
      );
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');
    if (iv.length !== IV_LENGTH) {
      throw new InternalServerErrorException(
        'WebhookCrypto.decrypt: invalid IV length',
      );
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new InternalServerErrorException(
        'WebhookCrypto.decrypt: invalid auth-tag length',
      );
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
