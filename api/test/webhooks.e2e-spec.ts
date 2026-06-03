// Set env vars BEFORE any imports so ConfigModule picks them up.
import { setupTestEnv } from './constants/test-config';
setupTestEnv();
process.env.WEBHOOK_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.WEBHOOK_ALLOW_HTTP = 'true'; // mock target is on 127.0.0.1
process.env.WEBHOOK_ALLOW_PRIVATE_IPS = 'true'; // ditto — relaxes the SSRF guard for tests

import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestAppContext,
} from './helpers/app.helper';
import { createUserWithToken, createMembership } from './helpers/user.helper';
import { createTestWorkspace } from './helpers/workspace.helper';
import {
  startMockWebhookTarget,
  MockWebhookTarget,
} from './utils/mock-webhook-target';

const WS_A = 'test_ws_webhooks_a';
const WS_B = 'test_ws_webhooks_b';

async function truncate(systemClient: TestAppContext['systemClient']): Promise<void> {
  await systemClient.command({ query: 'TRUNCATE TABLE webhook_definitions' });
  await systemClient.command({ query: 'TRUNCATE TABLE webhook_deliveries' });
}

describe('Webhooks CRUD + dispatch + multi-tenant', () => {
  let ctx: TestAppContext;
  let authToken: string;
  let authUserId: string;
  let mock: MockWebhookTarget;

  beforeAll(async () => {
    ctx = await createTestApp();
    mock = await startMockWebhookTarget();

    const { id, token } = await createUserWithToken(
      ctx.app,
      ctx.systemClient,
      'webhooks-test@test.com',
      undefined,
      { name: 'Webhooks Test User', isSuperAdmin: true },
    );
    authToken = token;
    authUserId = id;

    for (const ws of [WS_A, WS_B]) {
      await createTestWorkspace(ctx.systemClient, ws);
      await createMembership(ctx.systemClient, ws, authUserId, 'owner');
    }
  }, 60_000);

  afterAll(async () => {
    await mock.close();
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncate(ctx.systemClient);
    mock.reset();
  });

  describe('POST /api/webhooks.create', () => {
    it('creates a webhook and returns it without leaking the secret', async () => {
      const body = {
        workspace_id: WS_A,
        name: 'CRM hook',
        url: `${mock.url}/hook`,
        events: ['screen_view'],
        auth: { type: 'bearer', token: 'sk_super_secret' },
        filters: [{ field: 'utm.source', op: 'equals', value: 'google_ads' }],
        transform: { type: 'passthrough' },
      };
      const res = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send(body)
        .expect(201);

      expect(res.body.id).toMatch(/^wh_/);
      expect(res.body.workspace_id).toBe(WS_A);
      expect(res.body.auth).toEqual({ type: 'bearer', has_secret: true });
      expect(res.body.auth_secret_encrypted).toBeUndefined();
      expect(res.body.url).toBe(`${mock.url}/hook`);
    });

    // Note: SSRF allowlist coverage lives in `webhook-ssrf.e2e-spec.ts`
    // which sets WEBHOOK_ALLOW_PRIVATE_IPS=false. Duplicating the test here
    // is impossible because this suite relaxes private IPs globally so the
    // mock target on 127.0.0.1 is reachable.

    it('rejects duplicate names (409)', async () => {
      const payload = {
        workspace_id: WS_A,
        name: 'duplicate',
        url: `${mock.url}/d1`,
        events: ['screen_view'],
        auth: { type: 'none' },
      };
      await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send(payload)
        .expect(201);
      const res = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send(payload)
        .expect(409);
      expect(res.body.code ?? res.body.message?.code).toBe('DUPLICATE_NAME');
    });

    it('rejects malformed URLs', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'bad',
          url: 'not-a-url',
          events: ['screen_view'],
          auth: { type: 'none' },
        })
        .expect(400);
    });
  });

  describe('GET /api/webhooks.list / .get', () => {
    it('lists workspace webhooks and supports active filter', async () => {
      const a = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'one',
          url: `${mock.url}/a`,
          events: ['screen_view'],
          auth: { type: 'none' },
          active: true,
        })
        .expect(201);
      await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'two',
          url: `${mock.url}/b`,
          events: ['screen_view'],
          auth: { type: 'none' },
          active: false,
        })
        .expect(201);
      const list = await request(ctx.app.getHttpServer())
        .get(`/api/webhooks.list?workspace_id=${WS_A}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);
      expect(list.body).toHaveLength(2);

      const activeOnly = await request(ctx.app.getHttpServer())
        .get(`/api/webhooks.list?workspace_id=${WS_A}&active=true`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);
      expect(activeOnly.body).toHaveLength(1);
      expect(activeOnly.body[0].id).toBe(a.body.id);
    });

    it('returns 404 when getting a webhook that does not belong to the workspace', async () => {
      const created = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'isolated',
          url: `${mock.url}/iso`,
          events: ['screen_view'],
          auth: { type: 'none' },
        })
        .expect(201);
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/webhooks.get?workspace_id=${WS_B}&id=${created.body.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
      expect(res.body.code ?? res.body.message?.code).toBe('WEBHOOK_NOT_FOUND');
    });
  });

  describe('POST /api/webhooks.update / .delete', () => {
    it('renames a webhook and updates the URL', async () => {
      const created = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'orig',
          url: `${mock.url}/x`,
          events: ['screen_view'],
          auth: { type: 'none' },
        })
        .expect(201);

      const updated = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.update')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          id: created.body.id,
          name: 'renamed',
          url: `${mock.url}/y`,
        })
        .expect(200);
      expect(updated.body.name).toBe('renamed');
      expect(updated.body.url).toBe(`${mock.url}/y`);
    });

    it('soft-deletes a webhook so subsequent GET returns 404', async () => {
      const created = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'todelete',
          url: `${mock.url}/d`,
          events: ['screen_view'],
          auth: { type: 'none' },
        })
        .expect(201);
      await request(ctx.app.getHttpServer())
        .post('/api/webhooks.delete')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ workspace_id: WS_A, id: created.body.id })
        .expect(200);
      await request(ctx.app.getHttpServer())
        .get(`/api/webhooks.get?workspace_id=${WS_A}&id=${created.body.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });

  describe('POST /api/webhooks.test', () => {
    it('synchronously delivers and returns success', async () => {
      mock.setBehavior({ status: 200, body: '{"received":true}' });
      const created = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'sync-test',
          url: `${mock.url}/t`,
          events: ['webhook.test'],
          auth: { type: 'bearer', token: 'tkn-1' },
        })
        .expect(201);

      const res = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.test')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ workspace_id: WS_A, id: created.body.id })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.http_status).toBe(200);

      // Mock target must have received the request with Bearer auth
      expect(mock.requests.length).toBeGreaterThan(0);
      const last = mock.requests[mock.requests.length - 1];
      expect(last.method).toBe('POST');
      expect(last.headers['authorization']).toBe('Bearer tkn-1');
    });
  });

  describe('multi-tenant isolation', () => {
    it('webhooks created by WS_A are invisible to WS_B', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'A only',
          url: `${mock.url}/a`,
          events: ['screen_view'],
          auth: { type: 'none' },
        })
        .expect(201);
      const list = await request(ctx.app.getHttpServer())
        .get(`/api/webhooks.list?workspace_id=${WS_B}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);
      expect(list.body).toEqual([]);
    });
  });

  describe('POST /api/track → dispatch → delivery insert', () => {
    it('inserts a pending delivery in webhook_deliveries when a matching event is tracked', async () => {
      const created = await request(ctx.app.getHttpServer())
        .post('/api/webhooks.create')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspace_id: WS_A,
          name: 'dispatch test',
          url: `${mock.url}/dispatch`,
          events: ['screen_view'],
          auth: { type: 'none' },
          filters: [],
        })
        .expect(201);

      // Fire a synthetic track payload
      await request(ctx.app.getHttpServer())
        .post('/api/track')
        .send({
          workspace_id: WS_A,
          session_id: `sess-${Date.now()}`,
          created_at: Date.now() - 10_000,
          updated_at: Date.now(),
          actions: [
            {
              type: 'pageview',
              path: '/audit',
              page_number: 1,
              duration: 5000,
              scroll: 50,
              entered_at: Date.now() - 5000,
              exited_at: Date.now(),
            },
          ],
        })
        .set('Origin', `https://example.com`);

      // Poll for the delivery row (EventEmitter2 + ClickHouse insert is async).
      let rows: Array<{ status: string; attempt: number }> = [];
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        const result = await ctx.systemClient.query({
          query:
            'SELECT status, attempt FROM webhook_deliveries FINAL WHERE workspace_id = {ws:String} AND webhook_id = {wh:String}',
          query_params: { ws: WS_A, wh: created.body.id },
          format: 'JSONEachRow',
        });
        rows = (await result.json()) as Array<{ status: string; attempt: number }>;
        if (rows.length > 0) break;
      }
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(['pending', 'success', 'retrying']).toContain(rows[0].status);
    }, 30_000);
  });
});
