import {
  HealthProbeThrottle,
  ReadM2MThrottle,
  WriteM2MThrottle,
} from './throttle.decorator';

/**
 * Vérifie la config de rate-limit des décorateurs M2M plateforme
 * (ticket robustesse P2 2026-06-23 : la console se prenait des 429 sur une
 * rafale de lectures car les routes héritaient du throttler `auth` 10/min).
 *
 * On lit la métadonnée posée par @Throttle/@SkipThrottle directement sur la
 * méthode décorée — pas de runtime throttler nécessaire (désactivé en test).
 *
 * Clés de métadonnée @nestjs/throttler v6 (valeurs publiques stables, non
 * réexportées par l'index du package → on les fige ici) :
 *  - @SkipThrottle({ name: true })  → `THROTTLER:SKIP<name>` = true
 *  - @Throttle({ name: { limit } }) → `THROTTLER:LIMIT<name>` = limit
 */
const THROTTLER_SKIP = 'THROTTLER:SKIP';
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

function metaFor(decorate: () => MethodDecorator) {
  class Probe {
    handler() {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    Probe.prototype,
    'handler',
  )!;
  decorate()(Probe.prototype, 'handler', descriptor);
  // @nestjs/throttler pose la métadonnée sur `descriptor.value` (la fonction).
  const target = descriptor.value as object;
  const get = (key: string): unknown =>
    Reflect.getMetadata(key, target) as unknown;
  return {
    skip: (name: string) => get(`${THROTTLER_SKIP}${name}`),
    limit: (name: string) => get(`${THROTTLER_LIMIT}${name}`),
  };
}

describe('M2M throttle decorators', () => {
  describe('HealthProbeThrottle (probe stable mais bornée)', () => {
    const m = metaFor(HealthProbeThrottle);

    it('skips auth/default/ingest and keeps a dedicated 600/min budget', () => {
      expect(m.skip('auth')).toBe(true);
      expect(m.skip('default')).toBe(true);
      expect(m.skip('ingest')).toBe(true);
      expect(m.skip('analytics')).toBeUndefined();
      expect(m.limit('analytics')).toBe(600);
    });
  });

  describe('ReadM2MThrottle (lecture généreuse)', () => {
    const m = metaFor(ReadM2MThrottle);

    it('skips the strict auth/default/ingest throttlers', () => {
      expect(m.skip('auth')).toBe(true);
      expect(m.skip('default')).toBe(true);
      expect(m.skip('ingest')).toBe(true);
    });

    it('keeps only the generous `analytics` throttler (1000/min)', () => {
      expect(m.skip('analytics')).toBeUndefined();
      expect(m.limit('analytics')).toBe(1000);
    });
  });

  describe('WriteM2MThrottle (écriture/provisioning, sans auth:10)', () => {
    const m = metaFor(WriteM2MThrottle);

    it('skips auth/analytics/ingest', () => {
      expect(m.skip('auth')).toBe(true);
      expect(m.skip('analytics')).toBe(true);
      expect(m.skip('ingest')).toBe(true);
    });

    it('keeps the `default` throttler active at a moderate cap (300/min)', () => {
      expect(m.skip('default')).toBeUndefined();
      expect(m.limit('default')).toBe(300);
    });
  });
});
