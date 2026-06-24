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
  // Bind a real port so tracking.verify's loopback HTTP probe to /api/track
  // reaches THIS running app (supertest's in-memory server is not addressable
  // by an outbound fetch). Port 0 = OS-assigned; e2e runs --runInBand.
  await app.listen(0, '127.0.0.1');
  process.env.VERIFY_SELF_BASE_URL = `http://127.0.0.1:${new URL(await app.getUrl()).port}`;

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

  describe('POST /api/admin/platform/workspaces.provisionApiKey', () => {
    it('returns 401 without a Bearer token', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.provisionApiKey')
        .send({ workspace_id: 'whatever' })
        .expect(401);
    });

    it('returns 404 for an unknown workspace', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.provisionApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: 'ws_does_not_exist_xyz' })
        .expect(404);
    });

    it('provisions a workspace key for an existing (member-less) workspace', async () => {
      // Provision a tenant first to get a real, existing workspace.
      const tenant = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ name: 'Key Probe Co', email: `keyprobe-${Date.now()}@test.com`, siteUrl: 'https://kp.test' })
        .expect(201);
      const wsId = tenant.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.provisionApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId, name: 'Tunnel key' })
        .expect(201);

      expect(res.body.workspace_id).toBe(wsId);
      expect(res.body.api_key).toMatch(/^stam_live_/);
      expect(res.body.key_prefix).toMatch(/^stam_live_/);
    });
  });

  describe('POST /api/admin/platform/workspaces.revokeApiKey + listApiKeys', () => {
    it('returns 401 without a Bearer token', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.revokeApiKey')
        .send({ workspace_id: 'whatever', key_id: 'k1' })
        .expect(401);
    });

    it('returns 400 when neither key_id nor key_prefix is provided', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.revokeApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: 'ws_x' })
        .expect(400);
    });

    it('returns 404 for an unknown workspace', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.revokeApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: 'ws_does_not_exist_xyz', key_id: 'k1' })
        .expect(404);
    });

    it('full lifecycle: provision key → works → revoke → rejected → listed as revoked', async () => {
      // 1. Provision a real tenant + workspace.
      const tenant = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'Revoke Lifecycle Co',
          email: `revoke-life-${Date.now()}@test.com`,
          siteUrl: 'https://revoke.test',
        })
        .expect(201);
      const wsId = tenant.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      // 2. Provision a fresh workspace-scoped key via the M2M endpoint.
      const provisioned = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.provisionApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId, name: 'Lifecycle key' })
        .expect(201);
      const apiKey: string = provisioned.body.api_key;
      const keyPrefix: string = provisioned.body.key_prefix;
      await waitForMutations(ctx.systemClient, 'api_keys');

      // 3. The key WORKS on a workspace-scoped endpoint (active → 200).
      await request(ctx.app.getHttpServer())
        .get('/api/members.list')
        .query({ workspace_id: wsId })
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(200);

      // 3b. listApiKeys (M2M) shows it active, never leaking the secret.
      const beforeList = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.listApiKeys')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId })
        .expect(200);
      expect(beforeList.body.api_keys.length).toBeGreaterThanOrEqual(1);
      const activeEntry = beforeList.body.api_keys.find(
        (k: { key_prefix: string }) => k.key_prefix === keyPrefix,
      );
      expect(activeEntry).toBeDefined();
      expect(activeEntry.status).toBe('active');
      expect(activeEntry).not.toHaveProperty('key_hash');

      // 4. Revoke it by key_prefix (the only handle the caller kept).
      const revoked = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.revokeApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId, key_prefix: keyPrefix })
        .expect(200);
      expect(revoked.body.status).toBe('revoked');
      expect(revoked.body.key_prefix).toBe(keyPrefix);
      await waitForMutations(ctx.systemClient, 'api_keys');

      // 5. The SAME key is now REFUSED (revoked → 401). This is the whole
      //    point of the ticket: a revoked key must stop authenticating.
      await request(ctx.app.getHttpServer())
        .get('/api/members.list')
        .query({ workspace_id: wsId })
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(401);

      // 6. listApiKeys now reports it as revoked.
      const afterList = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.listApiKeys')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId, status: 'revoked' })
        .expect(200);
      const revokedEntry = afterList.body.api_keys.find(
        (k: { key_prefix: string }) => k.key_prefix === keyPrefix,
      );
      expect(revokedEntry).toBeDefined();
      expect(revokedEntry.status).toBe('revoked');

      // 7. Re-revoking is idempotent (retry-safe, still 200).
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.revokeApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId, key_prefix: keyPrefix })
        .expect(200);
    });

    it('does not revoke a key belonging to another workspace (404)', async () => {
      // Workspace A with a key.
      const tenantA = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'Cross WS A',
          email: `cross-a-${Date.now()}@test.com`,
          siteUrl: 'https://a.test',
        })
        .expect(201);
      const wsA = tenantA.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');
      const keyA = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.provisionApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsA })
        .expect(201);
      await waitForMutations(ctx.systemClient, 'api_keys');

      // Workspace B tries to revoke A's key by prefix → not found in B.
      const tenantB = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'Cross WS B',
          email: `cross-b-${Date.now()}@test.com`,
          siteUrl: 'https://b.test',
        })
        .expect(201);
      const wsB = tenantB.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.revokeApiKey')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsB, key_prefix: keyA.body.key_prefix })
        .expect(404);

      // A's key still works (was never touched).
      await request(ctx.app.getHttpServer())
        .get('/api/members.list')
        .query({ workspace_id: wsA })
        .set('Authorization', `Bearer ${keyA.body.api_key}`)
        .expect(200);
    });
  });

  describe('tenants.provision with explicit workspace_id (D2 migration)', () => {
    it('adopts the explicit workspace_id verbatim', async () => {
      const explicitId = `legacy_${Date.now().toString(36)}`;
      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          email: `explicit-${Date.now()}@test.com`,
          siteUrl: 'https://legacy.example.com',
          name: 'Legacy Client',
          workspace_id: explicitId,
        })
        .expect(201);
      expect(res.body.workspace_id).toBe(explicitId);
    });

    it('rejects an explicit workspace_id that breaks the id regex (409)', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          email: `badid-${Date.now()}@test.com`,
          siteUrl: 'https://badid.example.com',
          name: 'Bad Id Client',
          workspace_id: '1-invalid-Caps', // doit matcher ^[a-z][a-z0-9_]*$
        })
        .expect(409);
    });
  });

  describe('POST /api/admin/platform/analytics.query', () => {
    it('returns 401 without a Bearer token', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/analytics.query')
        .send({
          workspace_id: 'whatever',
          metrics: ['page_count'],
          table: 'pages',
          dateRange: { preset: 'previous_30_days' },
        })
        .expect(401);
    });

    it('returns 400 on invalid body (no metrics)', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/analytics.query')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          workspace_id: 'ws_x',
          dateRange: { preset: 'previous_30_days' },
        })
        .expect(400);
    });

    it('runs a query for a provisioned workspace (M2M, no workspace key)', async () => {
      const tenant = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'Analytics Probe Co',
          email: `aq-${Date.now()}@test.com`,
          siteUrl: 'https://aq.test',
        })
        .expect(201);
      const wsId = tenant.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/analytics.query')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          workspace_id: wsId,
          // page_count/table pages = la vraie métrique pageviews câblée dans le
          // query-builder natif (la métrique `pageviews` countIf(name=...) casse
          // car la colonne `name` n'existe pas dans les tables analytiques).
          metrics: ['page_count'],
          dimensions: [],
          dateRange: { preset: 'previous_30_days' },
          table: 'pages',
        })
        .expect(200);

      // Réponse native { data, meta } — un workspace neuf renvoie data vide.
      expect(res.body).toHaveProperty('data');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body).toHaveProperty('meta');
    });

    it('NEVER leaks raw ClickHouse SQL/params in the M2M response (no-SQL-leak contract)', async () => {
      // Garde-fou de contrat (ticket leak-sql 2026-06-24, OWASP — fuite de
      // structure interne) : AnalyticsResponse exposait `query.sql` (SQL CH
      // brut + noms de tables internes) dans CHAQUE 200 de analytics.query,
      // y compris cette route M2M plateforme consommée par le Hub/la skill.
      // Le champ a été retiré du contrat. Ce test rougit si on le réintroduit.
      const tenant = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'NoLeak Probe Co',
          email: `noleak-${Date.now()}@test.com`,
          siteUrl: 'https://noleak.test',
        })
        .expect(201);
      const wsId = tenant.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/analytics.query')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          workspace_id: wsId,
          metrics: ['page_count'],
          dimensions: [],
          dateRange: { preset: 'previous_30_days' },
          table: 'pages',
        })
        .expect(200);

      // Le champ `query` (qui portait { sql, params }) ne doit plus exister,
      // ni à la racine ni imbriqué dans `meta`.
      expect(res.body).not.toHaveProperty('query');
      expect(res.body.meta).not.toHaveProperty('query');

      // Défense en profondeur : AUCUN fragment de SQL ClickHouse brut ni de nom
      // de table interne ne doit transparaître nulle part dans le payload, quel
      // que soit le ré-emballage futur de la réponse.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/\bSELECT\b/i);
      expect(serialized).not.toMatch(/\bFROM\b/i);
      expect(serialized).not.toContain('countIf');
    });
  });

  describe('POST /api/admin/platform/analytics.funnel + conversionsByChannel', () => {
    it('runs a funnel for a provisioned workspace (M2M)', async () => {
      const tenant = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'Funnel Probe Co',
          email: `fn-${Date.now()}@test.com`,
          siteUrl: 'https://fn.test',
        })
        .expect(201);
      const wsId = tenant.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/analytics.funnel')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          workspace_id: wsId,
          steps: [{ goal_name: 'view' }, { goal_name: 'signup' }],
          dateRange: { preset: 'previous_30_days' },
        })
        .expect(200);

      // Empty workspace → entered 0, steps echoed back.
      expect(res.body).toHaveProperty('entered');
      expect(res.body.steps).toHaveLength(2);
      expect(res.body.unit).toBe('session');
    });

    it('rejects a funnel with < 2 steps (400)', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/analytics.funnel')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          workspace_id: 'ws_x',
          steps: [{ goal_name: 'only_one' }],
          dateRange: { preset: 'previous_30_days' },
        })
        .expect(400);
    });

    it('runs conversionsByChannel for a provisioned workspace (M2M)', async () => {
      const tenant = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'Conv Probe Co',
          email: `cv-${Date.now()}@test.com`,
          siteUrl: 'https://cv.test',
        })
        .expect(201);
      const wsId = tenant.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/analytics.conversionsByChannel')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          workspace_id: wsId,
          dateRange: { preset: 'previous_30_days' },
        })
        .expect(200);

      expect(res.body).toHaveProperty('rows');
      expect(Array.isArray(res.body.rows)).toBe(true);
      expect(res.body.conversion_goals).toEqual(['signup', 'app_started']);
    });
  });

  describe('POST /api/admin/platform/tracking.verify (dry-run, zero pollution)', () => {
    it('returns 200 + workspace_not_found verdict for an unknown workspace', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tracking.verify')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: 'ws_does_not_exist_verify' })
        .expect(200);
      expect(res.body.workspace_exists).toBe(false);
      expect(res.body.verdict).toBe('workspace_not_found');
      expect(res.body.ingestion.ok).toBe(false);
    });

    it('returns 400 when workspace_id is missing', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tracking.verify')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({})
        .expect(400);
    });

    it('round-trips a synthetic event end-to-end AND leaves sessions_30d UNCHANGED (zero pollution)', async () => {
      // Provision a real workspace (creates its ClickHouse db + tables).
      const tenant = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tenants.provision')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({
          name: 'Verify Probe Co',
          email: `verify-${Date.now()}@test.com`,
          siteUrl: 'https://verify.test',
        })
        .expect(201);
      const wsId: string = tenant.body.workspace_id;
      await waitForMutations(ctx.systemClient, 'workspaces');

      // Baseline real tracking BEFORE the verify call.
      const before = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.status')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId })
        .expect(200);
      const sessionsBefore = before.body.tracking?.sessions_30d ?? 0;

      // Verify (injects + purges a synthetic event through the real chain).
      const res = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/tracking.verify')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId })
        .expect(200);

      expect(res.body.workspace_exists).toBe(true);
      expect(res.body.ingestion.ok).toBe(true);
      expect(res.body.ingestion.round_trip_ms).toEqual(expect.any(Number));
      expect(res.body.ingestion.detail).toContain('ingested and purged');
      expect(res.body.snippet).toBeNull();
      expect(res.body.verdict).toBe('ok');

      // ZERO POLLUTION: real sessions_30d must be identical (synthetic event
      // anchored at the year-2000 sentinel + purged → never counted).
      const after = await request(ctx.app.getHttpServer())
        .post('/api/admin/platform/workspaces.status')
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: wsId })
        .expect(200);
      const sessionsAfter = after.body.tracking?.sessions_30d ?? 0;
      expect(sessionsAfter).toBe(sessionsBefore);
    });
  });
});

// Customization M2M (N1–N4) — roundtrip fonctionnel : on provisionne un tenant,
// on pose branding + features + crm_mapping, et getCustomization renvoie le tout.
describe('Admin Platform — customization M2M (branding/features/crm)', () => {
  let ctx: TestAppContext;
  let wsId: string;

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
    const prov = await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/tenants.provision')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({
        email: 'owner@yoga-sculpt.fr',
        siteUrl: 'https://yoga-sculpt.fr',
        name: 'Yoga Sculpt',
      })
      .expect(201);
    wsId = prov.body.workspace_id;
    await waitForMutations(ctx.systemClient, 'workspaces');
  });

  it('roundtrips branding + features + crm_mapping via getCustomization', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/workspaces.setBranding')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({ workspace_id: wsId, branding: { color: '#ff8800' } })
      .expect(200);
    await waitForMutations(ctx.systemClient, 'workspaces');

    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/workspaces.setFeatures')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({ workspace_id: wsId, features: { gsc: false, voip: true } })
      .expect(200);
    await waitForMutations(ctx.systemClient, 'workspaces');

    const mapping = {
      identity_resolver: 'field',
      identity_field: 'supabaseId',
      goals: [{ match: 'goal:purchase', timeline_name: 'achat' }],
    };
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/crm.setMapping')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({ workspace_id: wsId, crm_mapping: mapping })
      .expect(200);
    await waitForMutations(ctx.systemClient, 'workspaces');

    const res = await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/workspaces.getCustomization')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({ workspace_id: wsId })
      .expect(200);

    expect(res.body.branding).toEqual({ color: '#ff8800' });
    expect(res.body.features).toEqual({ gsc: false, voip: true });
    expect(res.body.crm_mapping).toMatchObject({
      identity_resolver: 'field',
      identity_field: 'supabaseId',
    });
  });

  it('rejects an invalid branding color (validation)', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/admin/platform/workspaces.setBranding')
      .set('Authorization', `Bearer ${PLATFORM_KEY}`)
      .send({ workspace_id: wsId, branding: { color: 'red' } })
      .expect(400);
  });
});

// Surface M2M IA-first (workspaces.status, voip.*, gsc.*, webhooks.*,
// workspaces.updateSettings, ads.conversions) — garantie de sécurité : AUCUN
// de ces endpoints ne doit être atteignable sans la clé plateforme. La logique
// métier est testée en unitaire (admin-platform.service.spec.ts) + au niveau des
// services workspace délégués ; ici on verrouille le contrat d'auth de la surface.
describe('Admin Platform — surface M2M IA-first : auth gate', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createAdminPlatformTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const M2M_ENDPOINTS = [
    'workspaces.status',
    'workspaces.updateSettings',
    'voip.listPhoneNumbers',
    'voip.addPhoneNumber',
    'voip.removePhoneNumber',
    'voip.listCredentials',
    'voip.saveCredential',
    'voip.testCredential',
    'voip.deleteCredential',
    'voip.sync',
    'gsc.status',
    'gsc.resync',
    'webhooks.list',
    'webhooks.create',
    'webhooks.delete',
    'webhooks.test',
    'ads.conversions',
    'tracking.verify',
    // Customization M2M (white-label + multi-industrie, N1–N4)
    'workspaces.getCustomization',
    'workspaces.setBranding',
    'workspaces.setFeatures',
    'workspaces.setLayout',
    'crm.setMapping',
    'crm.getMapping',
    // Attribution M2M (funnel + conversions par canal)
    'analytics.funnel',
    'analytics.conversionsByChannel',
  ];

  it.each(M2M_ENDPOINTS)(
    'POST %s returns 401 without Authorization header',
    async (endpoint) => {
      await request(ctx.app.getHttpServer())
        .post(`/api/admin/platform/${endpoint}`)
        .send({ workspace_id: 'whatever' })
        .expect(401);
    },
  );

  it.each(M2M_ENDPOINTS)(
    'POST %s returns 401 with a wrong Bearer token',
    async (endpoint) => {
      await request(ctx.app.getHttpServer())
        .post(`/api/admin/platform/${endpoint}`)
        .set('Authorization', 'Bearer not-the-real-key')
        .send({ workspace_id: 'whatever' })
        .expect(401);
    },
  );

  it.each(M2M_ENDPOINTS)(
    'POST %s with a VALID key does NOT return 401 (auth passes the guard)',
    async (endpoint) => {
      // On ne valide pas le métier ici (404/400/200 selon l'état) — seulement
      // que le guard M2M laisse passer la clé plateforme (donc PAS 401).
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/admin/platform/${endpoint}`)
        .set('Authorization', `Bearer ${PLATFORM_KEY}`)
        .send({ workspace_id: 'nonexistent_ws' });
      expect(res.status).not.toBe(401);
    },
  );
});
