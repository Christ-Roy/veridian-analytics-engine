import { ValidationPipe } from '@nestjs/common';
import { CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Request } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { MigrationsRunner } from './migrations/migrations.service';
import { APP_VERSION } from './version';

async function bootstrap() {
  // Run migrations BEFORE NestJS bootstrap
  const migrations = new MigrationsRunner();
  const needsRestart = await migrations.run();

  if (needsRestart) {
    console.log('[Migrations] Restarting server...');
    process.exit(0);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // ---------------------------------------------------------------------------
  // Security headers (BUG-17 + BUG-18 audit commercial 2026-05-25)
  // ---------------------------------------------------------------------------
  // 1. Désactive `X-Powered-By: Express` (fingerprinting techno).
  // 2. Pose les headers sécu standards via helmet : CSP, HSTS, X-Frame-Options,
  //    Referrer-Policy, X-Content-Type-Options, etc.
  //
  // CSP pensée pour la SPA Vite servie en statique par NestJS + l'API REST :
  //   - default-src 'self'           : tout vient de l'origine par défaut
  //   - script-src 'self'            : pas d'inline (Vite injecte des <script type="module" src="...">,
  //                                    pas d'eval), pas de CDN externe
  //   - style-src 'self' 'unsafe-inline' : Tailwind + style inline du splash
  //                                         dans index.html. Strict CSP nonces
  //                                         demanderait de re-toucher le build Vite.
  //   - img-src 'self' data: https://www.google.com : favicons referrers
  //     (LiveReferrersWidget tape google.com/s2/favicons), data: pour les SVG inline.
  //   - connect-src 'self' : XHR/fetch vers la même origine (l'API est sur le
  //     même domaine que la console).
  //   - font-src 'self' data: : pas de Google Fonts externes (confirmé via grep).
  //   - frame-ancestors 'none' : anti-clickjacking (équivalent X-Frame-Options DENY).
  //   - base-uri 'self', form-action 'self', object-src 'none' : durcissement.
  //
  // Si une route inattendue casse à cause de la CSP, fallback : passer en mode
  // report-only via env CSP_REPORT_ONLY=true.
  // ---------------------------------------------------------------------------
  app.disable('x-powered-by');

  const cspReportOnly = process.env.CSP_REPORT_ONLY === 'true';

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        reportOnly: cspReportOnly,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'https://www.google.com'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'worker-src': ["'self'", 'blob:'],
          'manifest-src': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false, // évite de casser les requêtes cross-origin SDK
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // SDK tracker chargé par sites clients
      strictTransportSecurity: {
        maxAge: 15552000, // 180 jours
        includeSubDomains: true,
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // Parse allowed origins from env (empty array = allow all)
  const allowedOriginsEnv = process.env.CORS_ALLOWED_ORIGINS;
  const allowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  // Route-aware CORS: track endpoints always permissive, others check list
  const corsOptionsDelegate: CorsOptionsDelegate<Request> = (req, callback) => {
    const origin = req.headers.origin;
    const path = req.url || '';

    // Track endpoints: always allow all origins (SDK on customer websites)
    if (path.startsWith('/api/track')) {
      return callback(null, { origin: true, credentials: true });
    }

    // Other endpoints: check allowed origins
    if (allowedOrigins.length === 0) {
      // Default: allow all origins when env var not set
      return callback(null, { origin: true, credentials: true });
    }

    // Strict mode: only allow listed origins
    const allowed = !origin || allowedOrigins.includes(origin);
    callback(null, { origin: allowed, credentials: true });
  };

  app.enableCors(corsOptionsDelegate);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`Staminads API v${APP_VERSION} running on port ${port}`);
}
bootstrap();
