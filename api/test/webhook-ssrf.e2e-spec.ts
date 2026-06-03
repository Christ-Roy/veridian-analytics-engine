// Set env vars BEFORE any imports so ConfigModule picks them up.
import { setupTestEnv } from './constants/test-config';
setupTestEnv();
process.env.WEBHOOK_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.WEBHOOK_ALLOW_HTTP = 'false'; // production-like
process.env.WEBHOOK_ALLOW_PRIVATE_IPS = 'false'; // enforce SSRF allowlist

import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestAppContext,
} from './helpers/app.helper';
import { createUserWithToken, createMembership } from './helpers/user.helper';
import { createTestWorkspace } from './helpers/workspace.helper';

const WS = 'test_ws_webhook_ssrf';

describe('Webhooks SSRF allowlist', () => {
  let ctx: TestAppContext;
  let authToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const { id, token } = await createUserWithToken(
      ctx.app,
      ctx.systemClient,
      'webhooks-ssrf-test@test.com',
      undefined,
      { name: 'Webhooks SSRF Test', isSuperAdmin: true },
    );
    authToken = token;
    await createTestWorkspace(ctx.systemClient, WS);
    await createMembership(ctx.systemClient, WS, id, 'owner');
  }, 60_000);

  afterAll(async () => {
    await ctx.systemClient.command({ query: 'TRUNCATE TABLE webhook_definitions' });
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.systemClient.command({ query: 'TRUNCATE TABLE webhook_definitions' });
  });

  const create = (url: string) =>
    request(ctx.app.getHttpServer())
      .post('/api/webhooks.create')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: WS,
        name: `ssrf ${Date.now()}-${Math.random()}`,
        url,
        events: ['screen_view'],
        auth: { type: 'none' },
      });

  it.each([
    ['http://example.com/hook', 'http:// blocked in prod'],
    ['javascript:alert(1)', 'js scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['https://localhost/hook', 'localhost'],
    ['https://127.0.0.1/hook', 'loopback'],
    ['https://10.0.0.1/hook', 'RFC1918'],
    ['https://192.168.0.1/hook', 'RFC1918'],
    ['https://169.254.169.254/x', 'AWS metadata'],
    ['https://analytics-engine.app.veridian.site/api/track', 'engine self loop'],
  ])('rejects %s (%s)', async (url) => {
    const res = await create(url);
    expect([400, 403]).toContain(res.status);
    if (res.status === 403) {
      expect(['FORBIDDEN_TARGET', 'INVALID_URL']).toContain(
        res.body.code ?? res.body.message?.code,
      );
    }
  });

  it('accepts a normal HTTPS URL', async () => {
    const res = await create('https://crm.example.com/hook');
    expect(res.status).toBe(201);
  });
});
