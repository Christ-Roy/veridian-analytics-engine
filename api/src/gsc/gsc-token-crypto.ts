import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decrypt, deriveKey, encrypt } from '../common/crypto';
import { GscOauthTokens } from './entities/gsc-property.entity';

/**
 * Chiffrement des tokens OAuth GSC, clé DÉRIVÉE PAR WORKSPACE.
 *
 * Réutilise `common/crypto.ts` (le même AES-256-GCM clé-par-workspace que les
 * SMTP passwords et les API keys de l'engine). La clé maître vient de
 * `ENCRYPTION_KEY` (validée ≥32 chars par `config/env.validation.ts`) ; la clé
 * effective est `PBKDF2(ENCRYPTION_KEY, workspace_id)`. Compromettre un blob
 * d'un workspace ne donne RIEN sur les autres workspaces — contrairement à la
 * clé globale unique du bridge legacy.
 *
 * Format sur disque : "iv_hex:authTag_hex:ciphertext_hex" (cf encrypt()).
 */
@Injectable()
export class GscTokenCrypto {
  private readonly masterKey: string;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('ENCRYPTION_KEY');
    if (!key || key.length < 32) {
      // ConfigModule devrait déjà avoir refusé une ENCRYPTION_KEY courte ;
      // garde-fou défensif pour ne jamais chiffrer avec une clé faible.
      throw new InternalServerErrorException(
        'GscTokenCrypto: ENCRYPTION_KEY missing or <32 chars.',
      );
    }
    this.masterKey = key;
  }

  encryptTokens(tokens: GscOauthTokens, workspaceId: string): string {
    const key = deriveKey(this.masterKey, workspaceId);
    return encrypt(JSON.stringify(tokens), key);
  }

  decryptTokens(blob: string, workspaceId: string): GscOauthTokens {
    const key = deriveKey(this.masterKey, workspaceId);
    return JSON.parse(decrypt(blob, key)) as GscOauthTokens;
  }
}
