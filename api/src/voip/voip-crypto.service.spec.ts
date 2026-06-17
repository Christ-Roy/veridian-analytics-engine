import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { VoipCrypto } from './voip-crypto.service';

function cryptoWith(env: Record<string, string | undefined>): VoipCrypto {
  const config = {
    get: (k: string) => env[k],
  } as unknown as ConfigService;
  return new VoipCrypto(config);
}

describe('VoipCrypto', () => {
  it('round-trips a payload for a workspace', () => {
    const c = cryptoWith({ ENCRYPTION_KEY: 'k'.repeat(48) });
    const enc = c.encryptCreds('{"apiKey":"secret"}', 'ws_1');
    expect(enc).not.toContain('secret');
    expect(enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(c.decryptCreds(enc, 'ws_1')).toBe('{"apiKey":"secret"}');
  });

  it('derives a different key per workspace (cross-ws decrypt fails)', () => {
    const c = cryptoWith({ ENCRYPTION_KEY: 'k'.repeat(48) });
    const enc = c.encryptCreds('top-secret', 'ws_1');
    expect(() => c.decryptCreds(enc, 'ws_2')).toThrow();
  });

  it('prefers VOIP_ENCRYPTION_KEY over ENCRYPTION_KEY', () => {
    const a = cryptoWith({
      VOIP_ENCRYPTION_KEY: 'a'.repeat(40),
      ENCRYPTION_KEY: 'b'.repeat(40),
    });
    const b = cryptoWith({ ENCRYPTION_KEY: 'b'.repeat(40) });
    const enc = a.encryptCreds('x', 'ws_1');
    // Decrypting with the ENCRYPTION_KEY-only instance must fail (different key).
    expect(() => b.decryptCreds(enc, 'ws_1')).toThrow();
  });

  it('falls back to ENCRYPTION_KEY when VOIP key absent', () => {
    const c = cryptoWith({ ENCRYPTION_KEY: 'c'.repeat(40) });
    const enc = c.encryptCreds('x', 'ws_1');
    expect(c.decryptCreds(enc, 'ws_1')).toBe('x');
  });

  it('throws when no key ≥ 32 chars is available', () => {
    expect(() => cryptoWith({ ENCRYPTION_KEY: 'short' })).toThrow(
      InternalServerErrorException,
    );
    expect(() => cryptoWith({})).toThrow(InternalServerErrorException);
  });

  it('returns empty string for empty input (no crypto)', () => {
    const c = cryptoWith({ ENCRYPTION_KEY: 'k'.repeat(48) });
    expect(c.encryptCreds('', 'ws_1')).toBe('');
    expect(c.decryptCreds('', 'ws_1')).toBe('');
  });
});
