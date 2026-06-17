// Set env vars BEFORE any imports to ensure ConfigModule picks them up
import { setupTestEnv } from './constants/test-config';
setupTestEnv();

import { ClickHouseClient } from '@clickhouse/client';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestAppContext,
} from './helpers/app.helper';
import {
  createTestWorkspace,
  createTestApiKey,
} from './helpers/workspace.helper';
import { createUserWithToken, createMembership } from './helpers/user.helper';
import { truncateSystemTables } from './helpers/cleanup.helper';
import { waitForClickHouse } from './helpers/wait.helper';

const testWorkspaceId = 'gsc_test_ws';
const otherWorkspaceId = 'gsc_other_ws';

/**
 * E2E GSC contre ClickHouse réel (cf CI-ARCHITECTURE §2.5 — `gsc/*` est
 * critique). Vérifie surtout l'AUTH NATIVE (la raison d'être du port) :
 *
 *  - aucun token → 401
 *  - clé API d'un autre workspace → 403 (PLUS de Bearer admin global)
 *  - clé API du bon workspace → 200, dashboard `property:null` pour un ws neuf
 *  - oauth-callback PUBLIC mais protégé par la signature HMAC du state
 */
describe('GSC native module E2E', () => {
  let ctx: TestAppContext;
  let systemClient: ClickHouseClient;
  let userId: string;
  let jwtToken: string;

  beforeAll(async () => {
    ctx = await createTestApp({ workspaceId: testWorkspaceId });
    systemClient = ctx.systemClient;
    const { id, token } = await createUserWithToken(
      ctx.app,
      systemClient,
      'gsc-e2e@test.com',
    );
    userId = id;
    jwtToken = token;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await truncateSystemTables(systemClient, [
      'workspaces',
      'api_keys',
      'workspace_memberships',
    ]);
    // gsc_property / gsc_daily ne sont pas dans le type SystemTable de
    // cleanup.helper → TRUNCATE direct (même pattern que webhooks.e2e-spec).
    await systemClient.command({ query: 'TRUNCATE TABLE gsc_property' });
    await systemClient.command({ query: 'TRUNCATE TABLE gsc_daily' });
    await createTestWorkspace(systemClient, testWorkspaceId);
    await createTestWorkspace(systemClient, otherWorkspaceId);
    await createMembership(systemClient, testWorkspaceId, userId, 'owner');
    await waitForClickHouse();
  });

  describe('auth', () => {
    it('rejects an unauthenticated dashboard request (401)', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/gsc/dashboard')
        .query({ workspace_id: testWorkspaceId })
        .expect(401);
    });

    it('rejects an API key bound to a different workspace (403)', async () => {
      const apiKey = await createTestApiKey(systemClient, otherWorkspaceId, {
        role: 'viewer',
      });
      await request(ctx.app.getHttpServer())
        .get('/api/gsc/dashboard')
        .query({ workspace_id: testWorkspaceId })
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(403);
    });

    it('allows a viewer API key of the bound workspace (200)', async () => {
      const apiKey = await createTestApiKey(systemClient, testWorkspaceId, {
        role: 'viewer',
      });
      const res = await request(ctx.app.getHttpServer())
        .get('/api/gsc/dashboard')
        .query({ workspace_id: testWorkspaceId, days: 28 })
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(200);
      // Workspace neuf → pas de property connectée.
      expect(res.body.property).toBeNull();
      expect(res.body.totals).toEqual({
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: 0,
      });
      expect(res.body.workspaceId).toBe(testWorkspaceId);
    });

    it('rejects a viewer from connecting (gsc.manage required, 403)', async () => {
      const apiKey = await createTestApiKey(systemClient, testWorkspaceId, {
        role: 'viewer',
      });
      // GSC n'est pas configuré sur l'instance de test → si la permission
      // passait on aurait 503 ; un viewer doit être bloqué AVANT (403).
      await request(ctx.app.getHttpServer())
        .post('/api/gsc/oauth-begin')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ workspace_id: testWorkspaceId })
        .expect(403);
    });
  });

  describe('status', () => {
    it('reports not-connected for a fresh workspace', async () => {
      const apiKey = await createTestApiKey(systemClient, testWorkspaceId, {
        role: 'viewer',
      });
      const res = await request(ctx.app.getHttpServer())
        .get('/api/gsc/status')
        .query({ workspace_id: testWorkspaceId })
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(200);
      expect(res.body.connected).toBe(false);
    });
  });

  describe('oauth-callback (public, HMAC-protected)', () => {
    it('rejects a missing code/state with 400', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/gsc/oauth-callback')
        .expect(400);
    });

    it('rejects a forged state (HMAC mismatch)', async () => {
      // state non signé → parseState lève GscOauthFlowError → 400 JSON.
      const res = await request(ctx.app.getHttpServer())
        .get('/api/gsc/oauth-callback')
        .query({ code: 'x', state: 'gsc_test_ws.deadbeef' });
      expect([400, 503]).toContain(res.status);
      expect(res.body.ok).not.toBe(true);
    });
  });

  describe('resync (JWT)', () => {
    it('returns not_connected for a fresh workspace', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/gsc/resync')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ workspace_id: testWorkspaceId })
        .expect(200);
      expect(res.body.skipped).toBe('not_connected');
    });
  });
});
