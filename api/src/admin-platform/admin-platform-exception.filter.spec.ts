import {
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AdminPlatformExceptionFilter } from './admin-platform-exception.filter';

/**
 * Unit tests for the canonical M2M error filter. These assert the PURE mapping
 * (slug → code, status → error label) — but the real proof that the surface
 * speaks this contract end-to-end (through guard + pipe + controller) is the
 * CLI/curl validation against staging recorded in the ticket. A passing mock
 * here is necessary, not sufficient (cf feedback_mock_cache_le_bug).
 */
describe('AdminPlatformExceptionFilter', () => {
  const filter = new AdminPlatformExceptionFilter();

  function run(exception: HttpException): {
    status: number;
    body: Record<string, unknown>;
  } {
    let capturedStatus = 0;
    let capturedBody: Record<string, unknown> = {};
    const res = {
      status(code: number) {
        capturedStatus = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        capturedBody = payload;
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    return { status: capturedStatus, body: capturedBody };
  }

  it('always emits the 4 canonical fields', () => {
    const { body } = run(
      new NotFoundException({
        error: 'workspace_not_found',
        message: 'Workspace ghost does not exist.',
      }),
    );
    expect(Object.keys(body).sort()).toEqual([
      'code',
      'error',
      'message',
      'statusCode',
    ]);
  });

  it('maps the {error: slug} 404 (workspace_not_found) → WORKSPACE_NOT_FOUND', () => {
    const { status, body } = run(
      new NotFoundException({
        error: 'workspace_not_found',
        message: 'Workspace ghost does not exist.',
      }),
    );
    expect(status).toBe(404);
    expect(body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Workspace ghost does not exist.',
      code: 'WORKSPACE_NOT_FOUND',
    });
  });

  it('maps the {code: CREDENTIAL_NOT_FOUND} 404 → CREDENTIAL_NOT_FOUND', () => {
    const { body } = run(
      new NotFoundException({
        code: 'CREDENTIAL_NOT_FOUND',
        message: 'Aucun credential voip_ovh pour ce workspace.',
      }),
    );
    expect(body.code).toBe('CREDENTIAL_NOT_FOUND');
    expect(body.error).toBe('Not Found');
    expect(body.statusCode).toBe(404);
  });

  it('maps the NestJS-standard 404 with an API-key message → API_KEY_NOT_FOUND', () => {
    const { body } = run(
      new NotFoundException(
        'API key with prefix zzz not found in workspace ws1',
      ),
    );
    expect(body.code).toBe('API_KEY_NOT_FOUND');
    expect(body.error).toBe('Not Found');
  });

  it('maps a bare NestJS 404 (no slug, no api-key hint) → NOT_FOUND', () => {
    const { body } = run(new NotFoundException('nope'));
    expect(body.code).toBe('NOT_FOUND');
  });

  it('keeps the ValidationPipe message array, code VALIDATION_ERROR', () => {
    const { status, body } = run(
      new HttpException(
        {
          message: ['email must be an email', 'name must be a string'],
          error: 'Bad Request',
          statusCode: 400,
        },
        HttpStatus.BAD_REQUEST,
      ),
    );
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toBe('Bad Request');
    expect(body.message).toEqual([
      'email must be an email',
      'name must be a string',
    ]);
  });

  it('maps the 409 email conflict → EMAIL_ALREADY_EXISTS', () => {
    const { status, body } = run(
      new ConflictException({
        error: 'email_already_exists',
        message: 'A user already exists with this email.',
      }),
    );
    expect(status).toBe(409);
    expect(body.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(body.error).toBe('Conflict');
  });

  it('maps the phone-number {code: already_exists} 409 → PHONE_NUMBER_ALREADY_EXISTS', () => {
    const { body } = run(new ConflictException({ code: 'already_exists' }));
    expect(body.code).toBe('PHONE_NUMBER_ALREADY_EXISTS');
    expect(body.error).toBe('Conflict');
  });

  it('maps the {code: invalid_e164} 400 → INVALID_E164', () => {
    const { body } = run(
      new HttpException({ code: 'invalid_e164' }, HttpStatus.BAD_REQUEST),
    );
    expect(body.code).toBe('INVALID_E164');
    expect(body.error).toBe('Bad Request');
  });

  it('maps the guard string 401 → UNAUTHORIZED with HTTP label', () => {
    const { status, body } = run(
      new UnauthorizedException('Invalid platform admin API key'),
    );
    expect(status).toBe(401);
    expect(body).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid platform admin API key',
      code: 'UNAUTHORIZED',
    });
  });

  it('derives the HTTP error label from the status, not the thrown body', () => {
    // Thrown body carries a misleading error label; filter must override it
    // from the status (single source of truth) — no drift possible.
    const { body } = run(
      new ConflictException({ error: 'workspace_already_exists', message: 'x' }),
    );
    expect(body.error).toBe('Conflict'); // 409, derived
    expect(body.code).toBe('WORKSPACE_ALREADY_EXISTS');
  });
});
