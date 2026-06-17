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
});
