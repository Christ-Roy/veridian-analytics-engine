import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Guard for platform-level (M2M) admin endpoints.
 *
 * Validates `Authorization: Bearer <token>` against the
 * `PLATFORM_ADMIN_API_KEY` env var using a timing-safe comparison.
 *
 * IMPORTANT: this is distinct from `WorkspaceAuthGuard` which handles
 * workspace-scoped API keys (`stam_live_*`) and user JWTs. The platform
 * admin key is a SINGLE shared secret owned by the Hub / provisioning
 * skill — never give it to a customer.
 *
 * If `PLATFORM_ADMIN_API_KEY` is unset, the guard refuses ALL requests
 * (fail-closed — never accidentally expose the endpoint in environments
 * that forgot to configure the secret).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match) {
      throw new UnauthorizedException('Invalid Authorization header format');
    }

    const presented = match[1].trim();
    // Read from BOTH ConfigService and process.env to be robust against:
    //   (a) NestJS ConfigModule snapshot timing in Jest (the first
    //       AppModule compiled in a worker may snapshot process.env
    //       BEFORE a late `setupTestEnv()` write — subsequent specs in
    //       the same worker see stale config)
    //   (b) deploys where the env var was injected late (e.g. Dokploy
    //       ENV patched without container restart — process.env updated
    //       but ConfigModule not re-read)
    // process.env is the freshest source; ConfigService is the
    // canonical NestJS path. Either matches → accept.
    const expected =
      this.configService.get<string>('PLATFORM_ADMIN_API_KEY') ||
      process.env.PLATFORM_ADMIN_API_KEY ||
      '';

    if (!expected) {
      // Fail-closed: refuse if no secret configured. We log a warning so
      // an operator notices the misconfiguration (vs silently 401-ing).
      this.logger.warn(
        'PLATFORM_ADMIN_API_KEY is not configured — all /api/admin/platform/* requests will be rejected',
      );
      throw new UnauthorizedException('Platform admin endpoint not configured');
    }

    if (!this.timingSafeStringEqual(presented, expected)) {
      throw new UnauthorizedException('Invalid platform admin API key');
    }

    return true;
  }

  /**
   * Constant-time string comparison. Always processes both inputs to avoid
   * length-based timing leaks. Returns false if the lengths differ AFTER
   * the comparison has run on the longer side.
   */
  private timingSafeStringEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');

    // Make a buffer of the same length as `expected` to keep timing constant.
    const padded = Buffer.alloc(bBuf.length);
    aBuf.copy(padded, 0, 0, Math.min(aBuf.length, bBuf.length));

    const lengthsMatch = aBuf.length === bBuf.length;
    const contentsMatch = timingSafeEqual(padded, bBuf);
    return lengthsMatch && contentsMatch;
  }
}
