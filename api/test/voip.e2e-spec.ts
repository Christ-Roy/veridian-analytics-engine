// Set env vars BEFORE any imports so ConfigModule picks them up.
import { setupTestEnv } from './constants/test-config';
setupTestEnv();

import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestAppContext,
} from './helpers/app.helper';
import { createUserWithToken, createMembership } from './helpers/user.helper';
import { createTestWorkspace } from './helpers/workspace.helper';

const WS_A = 'test_ws_voip_a';
const WS_B = 'test_ws_voip_b';

async function truncate(
  systemClient: TestAppContext['systemClient'],
): Promise<void> {
  await systemClient.command({ query: 'TRUNCATE TABLE voip_credentials' });
  await systemClient.command({ query: 'TRUNCATE TABLE tenant_phone_numbers' });
}

describe('VoIP — credentials + phone numbers + multi-tenant', () => {
  let ctx: TestAppContext;
  let authToken: string;
  let authUserId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const { id, token } = await createUserWithToken(
      ctx.app,
      ctx.systemClient,
      'voip-test@test.com',
      undefined,
      { name: 'VoIP Test User', isSuperAdmin: true },
    );
    authToken = token;
    authUserId = id;
    for (const ws of [WS_A, WS_B]) {
      await createTestWorkspace(ctx.systemClient, ws);
      await createMembership(ctx.systemClient, ws, authUserId, 'owner');
    }
  }, 60_000);

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncate(ctx.systemClient);
  });

  const auth = () => ({ Authorization: `Bearer ${authToken}` });

  describe('credentials', () => {
    it('saves a Telnyx credential and never leaks the clear-text key', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/voip.saveCredential')
        .set(auth())
        .send({
          workspace_id: WS_A,
          kind: 'voip_telnyx',
          creds: { apiKey: 'KEY0123456789abcdef' },
        })
        .expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.credential.kind).toBe('voip_telnyx');
      expect(res.body.credential.status).toBe('untested');
      expect(res.body.credential.masked.apiKey).toBe('••••cdef');
      // No clear-text anywhere in the response.
      expect(JSON.stringify(res.body)).not.toContain('KEY0123456789abcdef');
    });

    it('lists credentials masked via voip.settings', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/voip.saveCredential')
        .set(auth())
        .send({
          workspace_id: WS_A,
          kind: 'voip_ovh',
          creds: {
            applicationKey: 'app-key-value',
            applicationSecret: 'app-secret-value',
            consumerKey: 'consumer-key-value',
          },
        })
        .expect(200);

      const res = await request(ctx.app.getHttpServer())
        .get(`/api/voip.settings?workspace_id=${WS_A}`)
        .set(auth())
        .expect(200);
      expect(res.body.credentials).toHaveLength(1);
      expect(res.body.credentials[0].masked.applicationKey).toBe('••••alue');
      expect(res.body.allowedSources).toContain('seo');
    });

    it('rejects invalid creds with 400', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/voip.saveCredential')
        .set(auth())
        .send({ workspace_id: WS_A, kind: 'voip_telnyx', creds: { apiKey: 'x' } })
        .expect(400);
    });

    it('soft-deletes a credential', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/voip.saveCredential')
        .set(auth())
        .send({ workspace_id: WS_A, kind: 'voip_telnyx', creds: { apiKey: 'KEYaaaabbbbcccc' } })
        .expect(200);
      await request(ctx.app.getHttpServer())
        .post('/api/voip.deleteCredential')
        .set(auth())
        .send({ workspace_id: WS_A, kind: 'voip_telnyx' })
        .expect(200);
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/voip.settings?workspace_id=${WS_A}`)
        .set(auth())
        .expect(200);
      expect(res.body.credentials).toHaveLength(0);
    });

    it('isolates credentials per workspace', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/voip.saveCredential')
        .set(auth())
        .send({ workspace_id: WS_A, kind: 'voip_telnyx', creds: { apiKey: 'KEYaaaabbbbcccc' } })
        .expect(200);
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/voip.settings?workspace_id=${WS_B}`)
        .set(auth())
        .expect(200);
      expect(res.body.credentials).toHaveLength(0);
    });
  });

  describe('phone numbers (1 numéro = 1 source)', () => {
    it('creates a number normalized to E.164', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/voip.createPhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, e164: '01 77 12 34 56', source: 'seo', label: 'Ligne SEO' })
        .expect(200);
      expect(res.body.phoneNumber.e164).toBe('+33177123456');
      expect(res.body.phoneNumber.source).toBe('seo');
    });

    it('rejects an unparseable number (400 invalid_e164)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/voip.createPhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, e164: 'not-a-number', source: 'seo' })
        .expect(400);
      expect(res.body.code ?? res.body.message?.code).toBe('invalid_e164');
    });

    it('rejects a duplicate number (409)', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/voip.createPhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, e164: '+33177123456', source: 'seo' })
        .expect(200);
      await request(ctx.app.getHttpServer())
        .post('/api/voip.createPhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, e164: '0177123456', source: 'ads' })
        .expect(409);
    });

    it('updates source/label, then lists it', async () => {
      const created = await request(ctx.app.getHttpServer())
        .post('/api/voip.createPhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, e164: '+33177123456', source: 'seo' })
        .expect(200);
      const id = created.body.phoneNumber.id;
      await request(ctx.app.getHttpServer())
        .post('/api/voip.updatePhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, id, source: 'ads', label: 'Campagne Ads' })
        .expect(200);
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/voip.listPhoneNumbers?workspace_id=${WS_A}`)
        .set(auth())
        .expect(200);
      expect(res.body.phoneNumbers[0].source).toBe('ads');
      expect(res.body.phoneNumbers[0].label).toBe('Campagne Ads');
    });

    it('soft-deletes a number', async () => {
      const created = await request(ctx.app.getHttpServer())
        .post('/api/voip.createPhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, e164: '+33177123456', source: 'seo' })
        .expect(200);
      await request(ctx.app.getHttpServer())
        .post('/api/voip.deletePhoneNumber')
        .set(auth())
        .send({ workspace_id: WS_A, id: created.body.phoneNumber.id })
        .expect(200);
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/voip.listPhoneNumbers?workspace_id=${WS_A}`)
        .set(auth())
        .expect(200);
      expect(res.body.phoneNumbers).toHaveLength(0);
    });
  });

  describe('auth', () => {
    it('rejects unauthenticated requests', async () => {
      await request(ctx.app.getHttpServer())
        .get(`/api/voip.settings?workspace_id=${WS_A}`)
        .expect(401);
    });
  });
});
