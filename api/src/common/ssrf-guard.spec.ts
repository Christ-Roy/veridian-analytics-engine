import { ForbiddenException } from '@nestjs/common';
import { SsrfGuard } from './ssrf-guard';

describe('SsrfGuard', () => {
  let guard: SsrfGuard;

  beforeEach(() => {
    guard = new SsrfGuard();
  });

  describe('isPrivateHostname', () => {
    it.each([
      'localhost',
      'localhost.localdomain',
      '127.0.0.1',
      '127.10.20.30',
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.1.100',
      '169.254.169.254', // AWS metadata
      '169.254.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd00:1234::1',
      'fe80::1',
    ])('flags %s as private', (host) => {
      expect(SsrfGuard.isPrivateHostname(host)).toBe(true);
    });

    it.each([
      'example.com',
      'api.example.com',
      '8.8.8.8',
      '1.1.1.1',
      '11.0.0.1', // 11/8 is public
      '172.32.0.1', // outside 172.16/12
      '192.169.0.1',
      'crm.app.veridian.site',
      '2001:db8::1',
    ])('lets %s through', (host) => {
      expect(SsrfGuard.isPrivateHostname(host)).toBe(false);
    });
  });

  describe('isEngineSelfHostname', () => {
    it.each([
      'analytics-engine.app.veridian.site',
      'analytics-engine.staging.veridian.site',
      'analytics-engine-bridge.app.veridian.site',
    ])('blocks %s (engine self)', (host) => {
      expect(SsrfGuard.isEngineSelfHostname(host)).toBe(true);
    });

    it.each(['analytics.app.veridian.site', 'engine.veridian.site', 'foo.veridian.site'])(
      'lets %s through',
      (host) => {
        expect(SsrfGuard.isEngineSelfHostname(host)).toBe(false);
      },
    );
  });

  describe('assertSafeUrl', () => {
    it('accepts a normal https URL', () => {
      expect(() => guard.assertSafeUrl('https://crm.example.com/hook')).not.toThrow();
    });

    it('rejects malformed URLs', () => {
      expect(() => guard.assertSafeUrl('not-a-url')).toThrow(ForbiddenException);
    });

    it('rejects javascript: / file: schemes', () => {
      expect(() => guard.assertSafeUrl('javascript:alert(1)')).toThrow(ForbiddenException);
      expect(() => guard.assertSafeUrl('file:///etc/passwd')).toThrow(ForbiddenException);
    });

    it('rejects http when allowHttp=false', () => {
      expect(() => guard.assertSafeUrl('http://example.com/x')).toThrow(ForbiddenException);
    });

    it('accepts http when allowHttp=true', () => {
      expect(() => guard.assertSafeUrl('http://example.com/x', { allowHttp: true })).not.toThrow();
    });

    it('rejects localhost', () => {
      expect(() => guard.assertSafeUrl('https://localhost:8000/x')).toThrow(ForbiddenException);
    });

    it('rejects 127.0.0.1', () => {
      expect(() => guard.assertSafeUrl('https://127.0.0.1/x')).toThrow(ForbiddenException);
    });

    it('rejects 169.254.169.254 (cloud metadata)', () => {
      expect(() => guard.assertSafeUrl('https://169.254.169.254/latest/meta-data/')).toThrow(
        ForbiddenException,
      );
    });

    it('rejects RFC1918 ranges', () => {
      expect(() => guard.assertSafeUrl('https://10.0.0.1/x')).toThrow(ForbiddenException);
      expect(() => guard.assertSafeUrl('https://192.168.0.1/x')).toThrow(ForbiddenException);
      expect(() => guard.assertSafeUrl('https://172.16.0.1/x')).toThrow(ForbiddenException);
    });

    it('rejects engine self URL (loop guard)', () => {
      expect(() => guard.assertSafeUrl('https://analytics-engine.app.veridian.site/api/track')).toThrow(
        ForbiddenException,
      );
    });

    it('exposes a FORBIDDEN_TARGET / INVALID_URL code on the response', () => {
      try {
        guard.assertSafeUrl('https://127.0.0.1/x');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const body = (err as ForbiddenException).getResponse() as { code?: string };
        expect(body.code).toBe('FORBIDDEN_TARGET');
      }
    });
  });

  describe('isPrivateIp', () => {
    it.each([
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.5',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1', // CGNAT
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1', // IPv4-mapped private
    ])('flags %s', (ip) => {
      expect(SsrfGuard.isPrivateIp(ip)).toBe(true);
    });

    it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2001:db8::1', '::ffff:8.8.8.8'])(
      'lets public %s through',
      (ip) => {
        expect(SsrfGuard.isPrivateIp(ip)).toBe(false);
      },
    );

    it('returns false for a non-IP string', () => {
      expect(SsrfGuard.isPrivateIp('example.com')).toBe(false);
    });
  });

  describe('assertSafeUrlResolved (DNS-aware pre-fetch guard)', () => {
    const guardWith = (resolver: (h: string) => Promise<Array<{ address: string }>>) =>
      new SsrfGuard(async (h) => (await resolver(h)).map((a) => ({ ...a, family: 4 })));

    it('accepts a hostname that resolves to a public IP', async () => {
      const g = guardWith(async () => [{ address: '93.184.216.34' }]);
      await expect(g.assertSafeUrlResolved('https://api.example.com/hook')).resolves.toBeUndefined();
    });

    it('rejects a hostname that resolves to loopback (DNS post-validation)', async () => {
      const g = guardWith(async () => [{ address: '127.0.0.1' }]);
      await expect(g.assertSafeUrlResolved('https://evil.example/hook')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects a hostname that resolves to the cloud-metadata IP', async () => {
      const g = guardWith(async () => [{ address: '169.254.169.254' }]);
      await expect(g.assertSafeUrlResolved('https://evil.example/hook')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects if ANY resolved IP is private (mixed A records)', async () => {
      const g = guardWith(async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]);
      await expect(g.assertSafeUrlResolved('https://evil.example/hook')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('still rejects a literal private IP without resolving', async () => {
      const resolver = jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
      const g = new SsrfGuard(resolver);
      await expect(g.assertSafeUrlResolved('https://127.0.0.1/x')).rejects.toThrow(ForbiddenException);
      expect(resolver).not.toHaveBeenCalled(); // literal IP → no DNS
    });

    it('does not resolve a literal public IP (short-circuit)', async () => {
      const resolver = jest.fn(async () => [{ address: '10.0.0.1', family: 4 }]);
      const g = new SsrfGuard(resolver);
      await expect(g.assertSafeUrlResolved('https://8.8.8.8/x')).resolves.toBeUndefined();
      expect(resolver).not.toHaveBeenCalled();
    });

    it('raises DNS_RESOLUTION_FAILED when the name cannot be resolved', async () => {
      const g = new SsrfGuard(async () => {
        throw new Error('ENOTFOUND');
      });
      try {
        await g.assertSafeUrlResolved('https://nope.example/hook');
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const body = (err as ForbiddenException).getResponse() as { code?: string };
        expect(body.code).toBe('DNS_RESOLUTION_FAILED');
      }
    });

    it('skips DNS resolution when allowPrivate is set (test/staging escape hatch)', async () => {
      const resolver = jest.fn(async () => [{ address: '10.0.0.1', family: 4 }]);
      const g = new SsrfGuard(resolver);
      await expect(
        g.assertSafeUrlResolved('http://localhost:9000/x', { allowHttp: true, allowPrivate: true }),
      ).resolves.toBeUndefined();
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});
