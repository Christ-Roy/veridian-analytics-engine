// Set env vars BEFORE any imports to ensure ConfigModule picks them up
import { setupTestEnv } from './constants/test-config';
setupTestEnv();

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * SdkController e2e — verifies the public tracker bundle endpoints.
 *
 * Strategy: the controller streams from `<dist>/public/sdk/v1/*` at runtime.
 * The e2e suite runs against `src/` (NestJS ts-jest), so `__dirname` resolves
 * to `src/sdk` and the controller looks at `src/public/sdk/v1/`. We plant
 * fixture files there before the app boots and clean up after.
 *
 * This proves:
 *  - public URLs `/sdk/v1/{tracker.js, tracker.esm.js, tracker.d.ts}` serve 200
 *  - correct MIME types are set
 *  - long-lived Cache-Control is applied
 *  - CORS wildcard is set so any customer origin can `<script src=>` the bundle
 *  - manifest.json reports the live bundle size
 *  - 404 with a helpful message when the build artifact is missing
 */
describe('SdkController (e2e)', () => {
  let app: INestApplication;
  const sdkDir = join(__dirname, '..', 'src', 'public', 'sdk', 'v1');
  const trackerPath = join(sdkDir, 'staminads.min.js');
  const trackerEsmPath = join(sdkDir, 'staminads.esm.js');
  const trackerTypesPath = join(sdkDir, 'staminads.d.ts');

  beforeAll(async () => {
    // Plant minimal fixture bundles — content doesn't matter, only shape.
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(trackerPath, 'window.Veridian=function(){return 1}');
    writeFileSync(trackerEsmPath, 'export default function(){return 1}');
    writeFileSync(trackerTypesPath, 'export declare const v: number;');

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    // Cleanup fixture files but leave the parent `public/` alone in case
    // the console build has output there.
    for (const f of [trackerPath, trackerEsmPath, trackerTypesPath]) {
      if (existsSync(f)) rmSync(f);
    }
  });

  describe('GET /sdk/v1/tracker.js (UMD bundle)', () => {
    it('returns 200 with JS MIME and long cache', async () => {
      const res = await request(app.getHttpServer()).get('/sdk/v1/tracker.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/javascript/);
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('max-age=3600');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.text).toContain('Veridian');
    });

    it('returns 404 with a clear message when artifact missing', async () => {
      rmSync(trackerPath);
      const res = await request(app.getHttpServer()).get('/sdk/v1/tracker.js');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: 'SDK build artifact missing',
      });
      // Restore for subsequent tests
      writeFileSync(trackerPath, 'window.Veridian=function(){return 1}');
    });
  });

  describe('GET /sdk/v1/tracker.esm.js (ESM bundle)', () => {
    it('returns 200 with JS MIME', async () => {
      const res = await request(app.getHttpServer()).get(
        '/sdk/v1/tracker.esm.js',
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/javascript/);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.text).toContain('export default');
    });
  });

  describe('GET /sdk/v1/tracker.d.ts (TypeScript declarations)', () => {
    it('returns 200 with text/plain MIME', async () => {
      const res = await request(app.getHttpServer()).get(
        '/sdk/v1/tracker.d.ts',
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('export declare const v');
    });
  });

  describe('GET /sdk/v1/manifest.json', () => {
    it('returns version + asset URLs + live bundle size', async () => {
      const res = await request(app.getHttpServer()).get(
        '/sdk/v1/manifest.json',
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sdk: '@veridian/analytics-tracker',
        version: 'v1',
        bundles: {
          umd: '/sdk/v1/tracker.js',
          esm: '/sdk/v1/tracker.esm.js',
          types: '/sdk/v1/tracker.d.ts',
        },
      });
      expect(res.body.umd_size_bytes).toBeGreaterThan(0);
      expect(res.body.cache_max_age_seconds).toBe(3600);
    });

    it('returns 404 when bundle is missing', async () => {
      rmSync(trackerPath);
      const res = await request(app.getHttpServer()).get(
        '/sdk/v1/manifest.json',
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('SDK build artifact missing');
      writeFileSync(trackerPath, 'window.Veridian=function(){return 1}');
    });
  });

  describe('CORS for SDK bundle', () => {
    it('allows any origin to fetch the bundle (CDN style)', async () => {
      const res = await request(app.getHttpServer())
        .get('/sdk/v1/tracker.js')
        .set('Origin', 'https://any-customer-site.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });
});

// Cleanup any stray `src/public/sdk` parent that we created exclusively for tests.
// The e2e suite is the only consumer of this path during test runs.
afterAll(() => {
  const parent = dirname(join(__dirname, '..', 'src', 'public', 'sdk'));
  // Only remove if we created it (avoid nuking a real `public/` from a local
  // console build). Heuristic: only remove `public/sdk` not `public/` itself.
  const sdkParent = join(__dirname, '..', 'src', 'public', 'sdk');
  if (existsSync(sdkParent)) {
    try {
      rmSync(sdkParent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  // Suppress unused-var warning for `parent`
  void parent;
});
