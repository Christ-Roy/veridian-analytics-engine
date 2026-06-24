import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Canonical error contract for the M2M platform-admin surface
 * (`/api/admin/platform/*`).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The 31 M2M routes used to leak FIVE different JSON error shapes for the same
 * "is this an error, which one" question (ticket
 * 2026-06-24-m2m-cinq-formats-erreur-incoherents). Three different 404 shapes
 * alone:
 *   • {error:'workspace_not_found', message}              (no statusCode)
 *   • {code:'CREDENTIAL_NOT_FOUND', message}              (no error/statusCode)
 *   • {message, error:'Not Found', statusCode:404}        (NestJS standard)
 * plus validation {message:[…],error:'Bad Request',statusCode:400} and the 409
 * provision slugs. A generic consumer (Hub, IA, CLI) could not branch reliably.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CANONICAL SHAPE (every error on this surface, always these 4 fields)
 *
 *   {
 *     "statusCode": <int>,        // the HTTP status (source of truth)
 *     "error":      "<string>",   // human HTTP label, DERIVED from statusCode
 *     "message":    <string|string[]>, // unchanged (validation arrays kept)
 *     "code":       "<UPPER_SNAKE>"    // machine-stable, ALWAYS present
 *   }
 *
 * `error` is ALWAYS derived from `statusCode` via the NestJS-standard label
 * (single source of truth — never hand-coded per case), so it can never drift
 * the day a status changes. `code` is the field a consumer switches on; it is
 * always present so `switch(resp.code)` needs no presence test.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CODE TABLE (legacy slug seen in the thrown body  →  canonical code @ status)
 *
 *   workspace_not_found            → WORKSPACE_NOT_FOUND            (404)
 *   workspace_already_exists       → WORKSPACE_ALREADY_EXISTS       (409)
 *   email_already_exists           → EMAIL_ALREADY_EXISTS           (409)
 *   invalid_workspace_id (legacy)  → INVALID_WORKSPACE_ID           (400)*
 *   CREDENTIAL_NOT_FOUND           → CREDENTIAL_NOT_FOUND           (404)
 *   WEBHOOK_NOT_FOUND              → WEBHOOK_NOT_FOUND              (404)
 *   NUMBER_NOT_FOUND               → NUMBER_NOT_FOUND               (404)
 *   invalid_e164                   → INVALID_E164                   (400)
 *   already_exists (phone number)  → PHONE_NUMBER_ALREADY_EXISTS    (409)
 *   INVALID_CREDS                  → INVALID_CREDS                  (400)
 *   provisioning_failed            → PROVISIONING_FAILED            (500)
 *   <validation pipe array>        → VALIDATION_ERROR               (400)
 *   <NestJS std 404, no slug>      → API_KEY_NOT_FOUND if the message mentions
 *                                    an API key, else NOT_FOUND     (404)
 *   <anything else>                → status-derived fallback
 *                                    (BAD_REQUEST / NOT_FOUND / CONFLICT /
 *                                     UNAUTHORIZED / TOO_MANY_REQUESTS /
 *                                     INTERNAL_ERROR …)
 *
 *   *invalid_workspace_id is now produced at the DTO layer as a normal
 *    validation error (400 VALIDATION_ERROR) — the legacy 409 service branch was
 *    removed (ticket 2026-06-24-provision-invalid-workspace-id-409-vs-400). The
 *    explicit mapping is kept defensively in case any path still emits the slug.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CLI COMPATIBILITY (verified by reading skills/analytics-provision/bin/analytics)
 *
 * The CLI's exit code depends ONLY on the HTTP status (`out()` → exit 2 if not
 * 200/201); the `status`/`verify`/`status:raw` commands parse fields of 200
 * responses, never error-body shapes. This filter NEVER changes a status here
 * (T2's 409→400 was fixed upstream at the DTO, not in this filter), so the CLI's
 * exit-code mapping is unaffected. The richer body is purely additive for it.
 */

/** Slugs found in custom thrown bodies → canonical machine code. */
const SLUG_TO_CODE: Record<string, string> = {
  workspace_not_found: 'WORKSPACE_NOT_FOUND',
  workspace_already_exists: 'WORKSPACE_ALREADY_EXISTS',
  email_already_exists: 'EMAIL_ALREADY_EXISTS',
  invalid_workspace_id: 'INVALID_WORKSPACE_ID',
  provisioning_failed: 'PROVISIONING_FAILED',
  // VoIP / webhooks already use UPPER or lower slugs in `code`:
  CREDENTIAL_NOT_FOUND: 'CREDENTIAL_NOT_FOUND',
  WEBHOOK_NOT_FOUND: 'WEBHOOK_NOT_FOUND',
  NUMBER_NOT_FOUND: 'NUMBER_NOT_FOUND',
  INVALID_CREDS: 'INVALID_CREDS',
  invalid_e164: 'INVALID_E164',
  already_exists: 'PHONE_NUMBER_ALREADY_EXISTS',
};

/** HTTP status → fallback machine code when no slug is carried in the body. */
const STATUS_TO_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
  [HttpStatus.BAD_GATEWAY]: 'BAD_GATEWAY',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.GATEWAY_TIMEOUT]: 'GATEWAY_TIMEOUT',
};

@Catch(HttpException)
export class AdminPlatformExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AdminPlatformExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const payload = exception.getResponse();

    const { message, slug } = this.extract(payload);
    const code = this.resolveCode(slug, status, message);

    res.status(status).json({
      statusCode: status,
      // Human HTTP label DERIVED from the status — single source of truth, never
      // hand-coded per case, so it can't drift when a status changes.
      error: this.httpLabel(status),
      message,
      code,
    });
  }

  /**
   * Pull `message` and the discriminating `slug` out of the thrown body.
   * NestJS HttpException bodies come in three forms:
   *   • string                          → message = it
   *   • { message, error?, code? }      → our custom + NestJS-standard shape
   *   • { message: string[] , … }       → ValidationPipe
   * The slug is whichever of `code` / `error` carries a machine token (we ignore
   * the human HTTP label like "Not Found" / "Bad Request").
   */
  private extract(payload: string | object): {
    message: string | string[];
    slug: string | null;
  } {
    if (typeof payload === 'string') {
      return { message: payload, slug: null };
    }
    const body = payload as Record<string, unknown>;
    const message = (body.message ?? 'Error') as string | string[];

    // Prefer an explicit `code`, then a machine `error` slug. A human HTTP label
    // ("Not Found", "Bad Request", "Conflict") is NOT a machine slug → ignore it
    // so it falls through to the status-derived fallback.
    const rawCode = typeof body.code === 'string' ? body.code : null;
    const rawError = typeof body.error === 'string' ? body.error : null;
    const slug =
      (rawCode && rawCode in SLUG_TO_CODE ? rawCode : null) ??
      (rawError && rawError in SLUG_TO_CODE ? rawError : null) ??
      rawCode; // keep an unknown explicit code rather than dropping it
    return { message, slug };
  }

  private resolveCode(
    slug: string | null,
    status: number,
    message: string | string[],
  ): string {
    // 1. Known legacy slug → its canonical code.
    if (slug && slug in SLUG_TO_CODE) return SLUG_TO_CODE[slug];

    // 2. NestJS-standard 404 with no slug: disambiguate the api-key revoke path
    //    so the Hub gets a specific code instead of a generic NOT_FOUND.
    if (
      status === HttpStatus.NOT_FOUND &&
      typeof message === 'string' &&
      /api key/i.test(message)
    ) {
      return 'API_KEY_NOT_FOUND';
    }

    // 3. An UNKNOWN but explicit machine code on the body (a future `{code:…}`
    //    not yet in the table): preserve it (upper-snake) rather than flatten it
    //    to a generic status fallback — a precise unknown code beats a vague
    //    VALIDATION_ERROR/NOT_FOUND. `slug` here is always a `body.code`
    //    (a `body.error` is only kept when it's a known slug — see extract()).
    if (slug) return slug.toUpperCase();

    // 4. No slug at all → status-derived fallback.
    return STATUS_TO_CODE[status] ?? 'ERROR';
  }

  /** NestJS-standard human label for an HTTP status (single source of truth). */
  private httpLabel(status: number): string {
    const name = HttpStatus[status];
    if (!name) return 'Error';
    // HttpStatus[404] === 'NOT_FOUND' → "Not Found"
    return name
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}
