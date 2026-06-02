import { Controller, Get, Header, HttpException, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
// `import type` is required by isolatedModules + emitDecoratorMetadata
// (TS1272): Response is only used as a parameter type annotation in
// `@Res()` handlers, never at runtime.
import type { Response } from 'express';
import { existsSync, createReadStream, statSync } from 'fs';
import { join } from 'path';
import { Public } from '../common/decorators/public.decorator';
import { SkipRateLimit } from '../common/decorators/throttle.decorator';

/**
 * SdkController — serves the public Veridian Analytics tracker bundle.
 *
 * Why a dedicated controller rather than ServeStaticModule?
 *  - We need explicit `Cache-Control: public, max-age=3600` and a permissive
 *    `Access-Control-Allow-Origin: *` so any customer site can `<script src=>`
 *    the bundle (and so CDN/edge caches do their job).
 *  - We freeze the public URL contract on `/sdk/v1/...` regardless of the
 *    underlying filename produced by rollup (today `staminads.min.js`).
 *    Breaking changes ship under `/sdk/v2/`, never overwrite v1.
 *  - We return 404 with a clear message if the build artifact is missing
 *    (image built without SDK stage) instead of falling through to the
 *    SPA index.html — which would be very confusing for integrators.
 *
 * Build pipeline:
 *   sdk-builder stage produces `sdk/dist/staminads.min.js` (UMD, ~20 KB gzip).
 *   Dockerfile copies `sdk/dist/*` into `dist/public/sdk/v1/` so this
 *   controller can stream the bundle from disk.
 *
 * Public surface (versioned, frozen):
 *   GET /sdk/v1/tracker.js        → UMD bundle (browser script tag)
 *   GET /sdk/v1/tracker.esm.js    → ESM bundle (bundlers / npm-less imports)
 *   GET /sdk/v1/tracker.d.ts      → TypeScript declarations
 */
@ApiTags('sdk')
@Controller('sdk/v1')
@SkipRateLimit() // Public CDN-style asset — never rate limit
export class SdkController {
  /**
   * `dist/public/sdk/v1/` at runtime (production Docker image).
   * `process.cwd()/dist/public/sdk/v1` is used as a fallback during local dev
   * (NestJS started from monorepo root, before Dockerfile copies happen).
   */
  private readonly sdkDir = join(__dirname, '..', 'public', 'sdk', 'v1');

  @Get('tracker.js')
  @Public()
  @Header('Cache-Control', 'public, max-age=3600, immutable')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Veridian Analytics tracker UMD bundle (browser <script>)',
  })
  @ApiResponse({ status: 200, description: 'JavaScript bundle' })
  @ApiResponse({ status: 404, description: 'SDK build artifact missing' })
  serveTrackerUmd(@Res() res: Response): void {
    this.streamSdkFile(res, 'staminads.min.js', 'application/javascript; charset=utf-8');
  }

  @Get('tracker.esm.js')
  @Public()
  @Header('Cache-Control', 'public, max-age=3600, immutable')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Veridian Analytics tracker ESM bundle' })
  serveTrackerEsm(@Res() res: Response): void {
    this.streamSdkFile(res, 'staminads.esm.js', 'application/javascript; charset=utf-8');
  }

  @Get('tracker.d.ts')
  @Public()
  @Header('Cache-Control', 'public, max-age=3600')
  @Header('Access-Control-Allow-Origin', '*')
  @ApiOperation({ summary: 'TypeScript declarations for the tracker' })
  serveTrackerTypes(@Res() res: Response): void {
    this.streamSdkFile(res, 'staminads.d.ts', 'text/plain; charset=utf-8');
  }

  /**
   * Lightweight discovery endpoint — confirms which version is currently
   * served and how to load the bundle. Useful for `curl` from an
   * integrator's site to verify the SDK is reachable end-to-end.
   */
  @Get('manifest.json')
  @Public()
  @Header('Cache-Control', 'public, max-age=60')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @ApiOperation({ summary: 'SDK v1 manifest (version + asset URLs)' })
  manifest(@Res() res: Response): void {
    const trackerPath = join(this.sdkDir, 'staminads.min.js');
    if (!existsSync(trackerPath)) {
      res.status(404).json({
        error: 'SDK build artifact missing',
        hint: 'The Docker image was built without the sdk-builder stage outputs.',
      });
      return;
    }
    const stats = statSync(trackerPath);
    res.json({
      sdk: '@veridian/analytics-tracker',
      version: 'v1',
      bundles: {
        umd: '/sdk/v1/tracker.js',
        esm: '/sdk/v1/tracker.esm.js',
        types: '/sdk/v1/tracker.d.ts',
      },
      umd_size_bytes: stats.size,
      cache_max_age_seconds: 3600,
      docs: 'https://github.com/Christ-Roy/veridian-analytics-engine/tree/main/sdk',
    });
  }

  private streamSdkFile(
    res: Response,
    filename: string,
    contentType: string,
  ): void {
    const filePath = join(this.sdkDir, filename);

    if (!existsSync(filePath)) {
      throw new HttpException(
        {
          error: 'SDK build artifact missing',
          file: filename,
          hint:
            'The Docker image was built without the sdk-builder stage outputs. ' +
            'Check the Dockerfile and rebuild.',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    res.setHeader('Content-Type', contentType);
    createReadStream(filePath).pipe(res);
  }
}
