import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { SetupService } from './setup.service';

@Injectable()
export class SetupMiddleware implements NestMiddleware {
  constructor(private readonly setupService: SetupService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const path = req.originalUrl || req.url || req.path;

    // Always allow setup routes
    if (path.startsWith('/api/setup')) {
      return next();
    }

    // Allow health check endpoint if it exists
    if (req.path === '/health' || req.path === '/api/health') {
      return next();
    }

    // Allow public runtime config + demo bootstrap endpoints.
    // - /api/public-config: the SPA polls this on boot to detect demo mode;
    //   it must answer even before the demo data is seeded.
    // - /api/demo.login: the public demo auto-login. It has its own 503
    //   handling when the demo data is not seeded yet, so it must reach the
    //   controller instead of being short-circuited here.
    if (req.path === '/api/public-config' || req.path === '/api/demo.login') {
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
