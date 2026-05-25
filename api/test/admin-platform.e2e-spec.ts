// Set env vars BEFORE any imports so ConfigModule picks them up.
// `setupTestEnv()` now also exports `PLATFORM_ADMIN_API_KEY` into
// process.env (see test-config.ts) — needed because ConfigModule
// snapshots env at compile time and previous suites may have already
// booted AppModule before this file runs.
import {
  setupTestEnv,
  PLATFORM_ADMIN_API_KEY as PLATFORM_KEY,
} from './constants/test-config';
setupTestEnv();

import request from 'supertest';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createClient } from '@clickhouse/client';
import { AppModule } from '../src/app.module';
import { PlatformAdminGuard } from '../src/admin-platform/guards/platform-admin.guard';
import { MailService } from '../src/mail/mail.service';
import { closeTestApp, TestAppContext } from './helpers/app.helper';
import { getSystemClientConfig } from './constants/test-config';
import { truncateSystemTables } from './helpers/cleanup.helper';
import { waitForMutations } from './helpers/wait.helper';

/**
 * Boots AppModule with PlatformAdminGuard OVERRIDDEN to use a
 * lightweight in-test secret. Without this, the real guard reads
 * PLATFORM_ADMIN_API_KEY via ConfigService — which, in a Jest worker
 * that has already booted AppModule for a previous spec, may return
 * `undefined` (snapshot frozen before this spec called setupTestEnv).
 * Hardcoding the expected key in the override decouples the suite
 * from any process.env / ConfigModule timing ambiguity.
 */
async function createAdminPlatformTestApp(): Promise<TestAppContext> {
  // Inline guard that checks against PLATFORM_KEY directly.
  const overrideGuard = {
    canActivate: (ctx: import('@nestjs/common').ExecutionContext): boolean => {
      const req = ctx.switchToHttp().getRequest();
      const auth = req.headers?.authorization;
      if (!auth || typeof auth !== 'string') {
        throw new (
          require('@nestjs/common').UnauthorizedException
        )('Missing Authorization header');
      }
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (!m) {
        throw new (
          require('@nestjs/common').UnauthorizedException
        )('Invalid Authorization header format');
      }
      const presented = m[1].trim();
      if (presented !== PLATFORM_KEY) {
        throw new (
          require('@nestjs/common').UnauthorizedException
        )('Invalid platform admin API key');
      }
      return true;
    },
  };

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideGuard(PlatformAdminGuard)
    .useValue(overrideGuard)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const systemClient = createClient(getSystemClientConfig());

  const mailService = moduleFixture.get<MailService>(MailService);
  jest.spyOn(mailService, 'sendPasswordReset').mockResolvedValue();
  jest.spyOn(mailService, 'sendInvitation').mockResolvedValue();
  jest.spyOn(mailService, 'sendWelcome').mockResolvedValue();

  return {
    app,
    moduleFixture,
    systemClient,
    mailService,
  };
}

describe('Admin Platform — POST /api/admin/platform/tenants.provision', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createAdminPlatformTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncateSystemTables(ctx.systemClient, [
      'workspaces',
      'workspace_memberships',
      'users',
      'api_keys',
      'invitations',
      'backfill_tasks',
      'password_reset_tokens',
    ]);
  });

  it('returns 401 when no Authorization header', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .send({
        email: 'noauth@example.com',
        siteUrl: 'https://example.com',
        name: 'NoAuth Test',
      })
      .expect(401);
  });

  it('returns 401 when Bearer token is wrong', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', 'Bearer not-the-real-key')
      .send({
        email: 'wrongkey@example.com',
        siteUrl: 'https://example.com',
        name: 'WrongKey Test',
      })
      .expect(401);
  });

  it('returns 401 when Authorization header is malformed', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', PLATFORM_KEY) // missing "Bearer "
      .send({
        email: 'malformed@example.com',
        siteUrl: 'https://example.com',
        name: 'Malformed Test',
      })
      .expect(401);
  });

  it('returns 400 when payload is invalid (missing email)', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({
        siteUrl: 'https://example.com',
        name: 'Missing Email',
      })
      .expect(400);
  });

  it('provisions a tenant end-to-end with valid Bearer + body', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({
        email: 'owner-e2e@example.com',
        siteUrl: 'https://e2e-tenant.example.com',
        name: 'E2E Boulangerie',
      })
      .expect(201);

    expect(response.body.workspace_id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(response.body.owner_user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(response.body.api_key).toMatch(/^stam_live_[a-f0-9]{64}$/);
    expect(response.body.snippet_html).toContain('tracker.js');
    expect(response.body.snippet_html).toContain(response.body.workspace_id);
    expect(response.body.snippet_html).not.toContain('stam_live_');
    expect(response.body.dashboard_url).toContain(response.body.workspace_id);
    expect(response.body.password_reset_url).toContain('/reset-password/');
    expect(response.body.phone_numbers).toEqual([]);
    expect(response.body.user_created).toBe(true);

    // Mail mock should have been called once.
    expect(ctx.mailService?.sendPasswordReset).toHaveBeenCalledTimes(1);

    // Persistence checks.
    // NOTE: `workspaces` table uses plain MergeTree (NOT ReplacingMergeTree),
    // so `FINAL` is rejected by ClickHouse. Use the dedupe pattern the
    // production code uses everywhere (see WorkspacesService.list/get and
    // AdminPlatformService.workspaceExists).
    await waitForMutations(ctx.systemClient, 'workspaces');
    const wsRows = await ctx.systemClient
      .query({
        query: `SELECT id FROM workspaces
                WHERE id = {id:String}
                  AND (id, updated_at) IN (
                    SELECT id, max(updated_at) FROM workspaces GROUP BY id
                  )
                LIMIT 1`,
        query_params: { id: response.body.workspace_id },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ id: string }>());
    expect(wsRows).toHaveLength(1);

    const userRows = await ctx.systemClient
      .query({
        query: `SELECT id, email FROM users FINAL WHERE id = {id:String}`,
        query_params: { id: response.body.owner_user_id },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ id: string; email: string }>());
    expect(userRows).toHaveLength(1);
    expect(userRows[0].email).toBe('owner-e2e@example.com');
  });

  it('returns 409 when email is already in use', async () => {
    // First call seeds the user.
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({
        email: 'dup@example.com',
        siteUrl: 'https://first.example.com',
        name: 'First Tenant',
      })
      .expect(201);

    // Second call with same email must 409.
    const dup = await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({
        email: 'dup@example.com',
        siteUrl: 'https://second.example.com',
        name: 'Second Tenant',
      })
      .expect(409);

    expect(dup.body.message?.error || dup.body.error).toBe(
      'email_already_exists',
    );
  });

  it('accepts phoneNumbers payload and marks them skipped when bridge unset', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({
        email: 'phones@example.com',
        siteUrl: 'https://phones.example.com',
        name: 'Phones Tenant',
        phoneNumbers: [
          { e164: '+33123456789', source: 'seo' },
          { e164: '+33987654321', source: 'ads' },
        ],
      })
      .expect(201);

    expect(response.body.phone_numbers).toHaveLength(2);
    expect(response.body.phone_numbers[0].status).toBe('skipped_no_bridge');
    expect(response.body.phone_numbers[1].status).toBe('skipped_no_bridge');
  });
});
