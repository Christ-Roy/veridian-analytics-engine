import { ConfigService } from '@nestjs/config';
import { WebhookCrypto } from './webhook-crypto';

function makeConfig(map: Record<string, string>): ConfigService {
  return {
    get: (key: string) => map[key],
  } as unknown as ConfigService;
}

describe('WebhookCrypto', () => {
  const MASTER = 'a'.repeat(64);

  it('round-trips a secret', () => {
    const crypto = new WebhookCrypto(makeConfig({ WEBHOOK_ENCRYPTION_KEY: MASTER }));
    const plaintext = 'sk_live_super_secret_123';
    const enc = crypto.encryptSecret(plaintext);
    expect(enc).not.toBe(plaintext);
    expect(enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(crypto.decryptSecret(enc)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const crypto = new WebhookCrypto(makeConfig({ WEBHOOK_ENCRYPTION_KEY: MASTER }));
    const enc1 = crypto.encryptSecret('hello');
    const enc2 = crypto.encryptSecret('hello');
    expect(enc1).not.toBe(enc2);
    expect(crypto.decryptSecret(enc1)).toBe('hello');
    expect(crypto.decryptSecret(enc2)).toBe('hello');
  });

  it('preserves the empty-string sentinel', () => {
    const crypto = new WebhookCrypto(makeConfig({ WEBHOOK_ENCRYPTION_KEY: MASTER }));
    expect(crypto.encryptSecret('')).toBe('');
    expect(crypto.decryptSecret('')).toBe('');
  });

  it('falls back to ENCRYPTION_KEY when WEBHOOK_ENCRYPTION_KEY is unset', () => {
    const crypto = new WebhookCrypto(makeConfig({ ENCRYPTION_KEY: MASTER }));
    const enc = crypto.encryptSecret('foo');
    expect(crypto.decryptSecret(enc)).toBe('foo');
  });

  it('throws when no key is available', () => {
    expect(
      () => new WebhookCrypto(makeConfig({})),
    ).toThrow(/no encryption key available/);
  });

  it('rejects tampered payloads (auth tag invalid)', () => {
    const crypto = new WebhookCrypto(makeConfig({ WEBHOOK_ENCRYPTION_KEY: MASTER }));
    const enc = crypto.encryptSecret('original');
    const [iv, tag, ct] = enc.split(':');
    // Flip a byte in the ciphertext
    const tampered = ct.slice(0, -2) + (ct.endsWith('00') ? '11' : '00');
    expect(() => crypto.decryptSecret(`${iv}:${tag}:${tampered}`)).toThrow();
  });

  it('rejects malformed payloads (wrong shape)', () => {
    const crypto = new WebhookCrypto(makeConfig({ WEBHOOK_ENCRYPTION_KEY: MASTER }));
    expect(() => crypto.decryptSecret('not-base64')).toThrow();
    expect(() => crypto.decryptSecret('a:b')).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const aliceKey = 'a'.repeat(64);
    const bobKey = 'b'.repeat(64);
    const alice = new WebhookCrypto(makeConfig({ WEBHOOK_ENCRYPTION_KEY: aliceKey }));
    const bob = new WebhookCrypto(makeConfig({ WEBHOOK_ENCRYPTION_KEY: bobKey }));
    const enc = alice.encryptSecret('plain');
    expect(() => bob.decryptSecret(enc)).toThrow();
  });
});
