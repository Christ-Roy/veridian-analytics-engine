import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { Request } from 'express';
import { getClientIp } from '../utils/ip.util';

/**
 * Custom throttler guard that uses proper IP extraction for proxied requests.
 * Handles CDN and proxy headers (Cloudflare, Nginx, Vercel, etc.)
 */
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  /**
   * Skip throttling in test mode or when @SkipThrottle() is applied.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip in test mode
    const isTest =
      process.env.NODE_ENV === 'test' ||
      process.env.CLICKHOUSE_SYSTEM_DATABASE?.includes('test');
    if (isTest) {
      return true;
    }

    // Let parent class handle @SkipThrottle() and rate limiting
    return super.canActivate(context);
  }

  /**
   * Extract tracker key for rate limiting.
   *
   * Par défaut : client IP (cohérent avec le décorateur @ClientIp).
   *
   * Cas /api/track (ingestion haut-volume — ticket ratelimit-dos 2026-06-23) :
   * on bucket par (workspace_id + IP) au lieu de l'IP seule. Raison : des
   * millions d'appareils derrière un même NAT partagent l'IP ; throttler par
   * IP brute casserait le tracking légitime d'un gros site. En combinant le
   * workspace_id (lu dans le body déjà parsé par body-parser, avant la
   * validation pipe), un gros site répartit son trafic sur des milliers de
   * couples distincts → jamais throttlé, tandis qu'un flood concentré (même
   * workspace + même IP) sature un unique bucket → bloqué.
   *
   * NOTE: req.ip est dé-spoofé par `trust proxy` (cf main.ts), donc le
   * bucketing par IP n'est pas contournable via X-Forwarded-For.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  protected async getTracker(req: Request): Promise<string> {
    const ip = getClientIp(req) || req.socket?.remoteAddress || 'unknown';

    // Route d'ingestion : bucket combiné workspace_id + IP.
    if (typeof req.path === 'string' && req.path.startsWith('/api/track')) {
      const body = req.body as { workspace_id?: unknown } | undefined;
      const wsId =
        body && typeof body.workspace_id === 'string' && body.workspace_id
          ? body.workspace_id
          : 'no-ws';
      return `track:${wsId}:${ip}`;
    }

    return ip;
  }

  /**
   * Custom error message for rate limit exceeded.
   */
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  protected async throwThrottlingException(
    _context: ExecutionContext,
  ): Promise<void> {
    throw new ThrottlerException('Too many requests. Please try again later.');
  }
  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
}
