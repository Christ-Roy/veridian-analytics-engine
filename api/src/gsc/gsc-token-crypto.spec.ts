import { ConfigService } from '@nestjs/config';
import { GscTokenCrypto } from './gsc-token-crypto';
import { GscOauthTokens } from './entities/gsc-property.entity';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (key: string) => map[key] } as unknown as ConfigService;
}

const TOKENS: GscOauthTokens = {
  access_token: 'ya29.aaa',
  refresh_token: '1//rrr',
  expires_at: 1_900_000_000_000,
  scope: 'https://www.googleapis.com/auth/webmasters.readonly',
  token_type: 'Bearer',
};

describe('GscTokenCrypto', () => {
  const MASTER = 'k'.repeat(64);

  it('round-trips tokens for a workspace', () => {
    const crypto = new GscTokenCrypto(makeConfig({ ENCRYPTION_KEY: MASTER }));
    const blob = crypto.encryptTokens(TOKENS, 'ws_1');
    expect(blob).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(crypto.decryptTokens(blob, 'ws_1')).toEqual(TOKENS);
  });

  it('derives a different key per workspace (cross-workspace blob is undecryptable)', () => {
    const crypto = new GscTokenCrypto(makeConfig({ ENCRYPTION_KEY: MASTER }));
    const blob = crypto.encryptTokens(TOKENS, 'ws_1');
    // Decrypting ws_1's blob with ws_2's derived key must fail (GCM auth tag).
    expect(() => crypto.decryptTokens(blob, 'ws_2')).toThrow();
  });

  it('produces a fresh ciphertext each time (random IV)', () => {
    const crypto = new GscTokenCrypto(makeConfig({ ENCRYPTION_KEY: MASTER }));
    const a = crypto.encryptTokens(TOKENS, 'ws_1');
    const b = crypto.encryptTokens(TOKENS, 'ws_1');
    expect(a).not.toBe(b);
    expect(crypto.decryptTokens(a, 'ws_1')).toEqual(TOKENS);
    expect(crypto.decryptTokens(b, 'ws_1')).toEqual(TOKENS);
  });

  it('refuses a missing or too-short master key', () => {
    expect(() => new GscTokenCrypto(makeConfig({}))).toThrow();
    expect(
      () => new GscTokenCrypto(makeConfig({ ENCRYPTION_KEY: 'short' })),
    ).toThrow();
  });
});
