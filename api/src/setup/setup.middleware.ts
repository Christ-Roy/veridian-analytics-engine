import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { SetupService } from './setup.service';

@Injectable()
export class SetupMiddleware implements NestMiddleware {
  constructor(private readonly setupService: SetupService) {}

  // Endpoints exempt from the "setup not complete" 503 gate. Matched with
  // `startsWith` against the pathname (query string stripped) so that e.g.
  // `/api/demo.generate?secret=xxx` is recognised.
  //
  // - /api/setup        : the setup flow itself.
  // - /api/health       : liveness/readiness probe (Traefik, cron, monitoring)
  //                       — a probe must answer before setup is complete.
  // - /api/public-config: the SPA polls this on boot to detect demo mode;
  //                       it must answer even before the demo data is seeded.
  // - /api/demo.login   : the public demo auto-login. It has its own 503
  //                       handling when the demo is not seeded yet, so it
  //                       must reach the controller, not be short-circuited.
  // - /api/demo.generate, /api/demo.delete : the demo seed/re-seed
  //                       endpoints. `demo.generate` is the very call that
  //                       COMPLETES setup (creates the demo user + workspace)
  //                       — gating it on "setup not complete" is a
  //                       chicken-and-egg deadlock. Both stay protected by
  //                       `DemoSecretGuard` (timing-safe `?secret=`), which
  //                       runs after this middleware, so the bypass is safe.
  private static readonly EXEMPT_PREFIXES = [
    '/api/setup',
    '/api/health',
    '/api/public-config',
    '/api/demo.login',
    '/api/demo.generate',
    '/api/demo.delete',
  ];

  async use(req: Request, res: Response, next: NextFunction) {
    // `originalUrl` may carry a query string — strip it so prefix matching
    // works on the pathname alone.
    const rawUrl = req.originalUrl || req.url || req.path;
    const path = rawUrl.split('?')[0];

    // Allow setup, health, public-config and the demo bootstrap endpoints.
    if (SetupMiddleware.EXEMPT_PREFIXES.some((p) => path.startsWith(p))) {
      return next();
    }

    // Allow static files (console frontend) - anything not starting with /api
    if (!path.startsWith('/api')) {
      return next();
    }

    // Check if setup is complete
    const isComplete = await this.setupService.isSetupComplete();
    if (!isComplete) {
      return res.status(503).json({
        error: 'setup_required',
        message: 'Initial setup has not been completed',
      });
    }

    next();
  }
}
