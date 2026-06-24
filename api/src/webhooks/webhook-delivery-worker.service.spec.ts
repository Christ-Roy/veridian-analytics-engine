import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDeliveryWorker } from './webhook-delivery-worker.service';
import { WebhooksService } from './webhooks.service';
import { WebhookTransformEngine } from './webhook-transform-engine';
import { SsrfGuard } from '../common/ssrf-guard';
import { WebhookDefinition, DEFAULT_RETRY_CONFIG } from './entities/webhook-definition.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { TwentyConnectorService } from './connectors/twenty-connector.service';
import { TwentyEventMapper } from './connectors/twenty-event-mapper';
import { TwentyBudget } from './connectors/twenty-budget';
import { WorkspacesService } from '../workspaces/workspaces.service';

const baseWebhook: WebhookDefinition = {
  id: 'wh_unit_1',
  workspace_id: 'ws_a',
  name: 'unit',
  url: 'https://destination.example.com/hook',
  active: true,
  auth_type: 'bearer',
  auth_secret_encrypted: 'enc(token)',
  events: ['screen_view'],
  filters: [],
  transform: null,
  retry_config: DEFAULT_RETRY_CONFIG,
  created_at: '2026-06-03 12:00:00.000',
  updated_at: '2026-06-03 12:00:00.000',
  deleted_at: null,
};

const baseDelivery: WebhookDelivery = {
  id: 'del_unit_1',
  webhook_id: baseWebhook.id,
  workspace_id: baseWebhook.workspace_id,
  event_id: 'evt_unit',
  event_type: 'screen_view',
  attempt: 1,
  scheduled_at: '2026-06-03 12:00:00.000',
  sent_at: null,
  status: 'pending',
  http_status: null,
  latency_ms: null,
  request_url: baseWebhook.url,
  request_body: JSON.stringify({ event_type: 'screen_view', path: '/x' }),
  response_body: '',
  error_message: '',
  created_at: '2026-06-03 12:00:00.000',
  updated_at: '2026-06-03 12:00:00.000',
};

describe('WebhookDeliveryWorker', () => {
  let worker: WebhookDeliveryWorker;
  let webhooks: jest.Mocked<WebhooksService>;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    fetchMock = jest.fn();
    // @ts-expect-error: override global for the test
    global.fetch = fetchMock;

    webhooks = {
      findByIdInternal: jest.fn(async () => baseWebhook),
      findReadyDeliveries: jest.fn(async () => [baseDelivery]),
      updateDelivery: jest.fn(async () => undefined),
      decryptSecret: jest.fn(() => 'token'),
    } as unknown as jest.Mocked<WebhooksService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryWorker,
        { provide: WebhooksService, useValue: webhooks },
        WebhookTransformEngine,
        // Inject a stub DNS resolver so the pre-fetch SSRF guard never hits the
        // network: real names resolve to a public IP, the well-known internal
        // hostnames used in the SSRF tests resolve to private/metadata IPs.
        {
          provide: SsrfGuard,
          useValue: new SsrfGuard(async (hostname: string) => {
            if (hostname === 'rebind.evil.example') {
              return [{ address: '169.254.169.254', family: 4 }];
            }
            if (hostname === 'internal.evil.example') {
              return [{ address: '10.0.0.5', family: 4 }];
            }
            return [{ address: '93.184.216.34', family: 4 }]; // public (example.com)
          }),
        },
        TwentyEventMapper,
        TwentyConnectorService,
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'WEBHOOK_ALLOW_HTTP' ? 'false' : undefined) },
        },
        {
          // The connector reads each workspace's crm_mapping; stub it as "no
          // config" so these worker tests exercise the built-in prospection
          // mapping (unchanged behaviour), independent of the customization N4.
          provide: WorkspacesService,
          useValue: {
            get: async (id: string) => ({ id, settings: {} }),
          },
        },
      ],
    }).compile();

    worker = module.get(WebhookDeliveryWorker);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buildHeaders', () => {
    it('adds a Bearer token when auth_type=bearer', () => {
      const h = worker.buildHeaders(baseWebhook, '{}');
      expect(h['authorization']).toBe('Bearer token');
      expect(h['content-type']).toBe('application/json');
      expect(h['x-webhook-id']).toBe('wh_unit_1');
    });

    it('base64-encodes Basic credentials', () => {
      const wh = { ...baseWebhook, auth_type: 'basic' as const };
      webhooks.decryptSecret = jest.fn(() => 'user:pass');
      const h = worker.buildHeaders(wh, '{}');
      expect(h['authorization']).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
    });

    it('signs the body when auth_type=hmac', () => {
      const wh = { ...baseWebhook, auth_type: 'hmac' as const };
      webhooks.decryptSecret = jest.fn(() => 'shared');
      const body = '{"x":1}';
      const h = worker.buildHeaders(wh, body);
      expect(h['x-veridian-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
  });

  describe('sendOne', () => {
    it('returns success on 2xx', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'OK',
      });
      const result = await worker.sendOne(baseWebhook, baseDelivery);
      expect(result.success).toBe(true);
      expect(result.http_status).toBe(200);
      expect(result.response_body).toBe('OK');
    });

    it('returns failure on 4xx', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      });
      const result = await worker.sendOne(baseWebhook, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.http_status).toBe(400);
    });

    it('captures network errors', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await worker.sendOne(baseWebhook, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.error_message).toMatch(/ECONNREFUSED/);
    });

    it('classifies AbortError as timeout', async () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      fetchMock.mockRejectedValueOnce(abort);
      const result = await worker.sendOne(baseWebhook, baseDelivery);
      expect(result.error_message).toBe('timeout');
    });
  });

  // ─── SSRF guard runs INSIDE sendOne → covers delivery AND webhooks.test ──
  describe('sendOne SSRF guard (single choke point)', () => {
    it('rejects a literal loopback URL before any fetch', async () => {
      const wh = { ...baseWebhook, url: 'https://127.0.0.1/internal' };
      const result = await worker.sendOne(wh, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.error_message).toMatch(/^ssrf:/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a literal cloud-metadata IP before any fetch', async () => {
      const wh = { ...baseWebhook, url: 'https://169.254.169.254/latest/meta-data/' };
      const result = await worker.sendOne(wh, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.error_message).toMatch(/^ssrf:/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a literal RFC1918 private IP before any fetch', async () => {
      const wh = { ...baseWebhook, url: 'https://10.0.0.5/admin' };
      const result = await worker.sendOne(wh, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.error_message).toMatch(/^ssrf:/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a hostname that RESOLVES to a private IP (DNS post-validation / rebinding)', async () => {
      // Literal check passes (public-looking name) but it resolves to 10.0.0.5.
      const wh = { ...baseWebhook, url: 'https://internal.evil.example/hook' };
      const result = await worker.sendOne(wh, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.error_message).toMatch(/^ssrf:/);
      expect(result.error_message).toMatch(/private/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a hostname that resolves to the cloud-metadata IP', async () => {
      const wh = { ...baseWebhook, url: 'https://rebind.evil.example/steal' };
      const result = await worker.sendOne(wh, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.error_message).toMatch(/^ssrf:/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does NOT follow a 3xx redirect (could point at an internal IP)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: { get: (h: string) => (h === 'location' ? 'http://169.254.169.254/' : null) },
        text: async () => '',
      });
      const result = await worker.sendOne(baseWebhook, baseDelivery);
      expect(result.success).toBe(false);
      expect(result.error_message).toMatch(/^redirect_blocked:/);
      // fetch was called exactly once with redirect:'manual' — never re-issued.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    });

    it('lets a public hostname through to the fetch', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'OK' });
      const result = await worker.sendOne(baseWebhook, baseDelivery);
      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // recordOutcome must NOT retry an SSRF / redirect rejection — they are terminal.
  describe('SSRF / redirect failures are terminal (no retry)', () => {
    it('marks an SSRF-resolved rejection as failed, not retrying', async () => {
      webhooks.findByIdInternal = jest.fn(async () => ({
        ...baseWebhook,
        url: 'https://internal.evil.example/hook',
      }));
      await worker.deliverOne(baseDelivery);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('failed');
      expect(updated.error_message).toMatch(/^ssrf:/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('marks a blocked redirect as failed, not retrying', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 301,
        headers: { get: () => 'http://10.0.0.1/' },
        text: async () => '',
      });
      await worker.deliverOne(baseDelivery);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('failed');
      expect(updated.error_message).toMatch(/^redirect_blocked:/);
    });
  });

  describe('deliverOne / retry logic', () => {
    it('marks delivery success on 2xx', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'ok',
      });
      await worker.deliverOne(baseDelivery);
      expect(webhooks.updateDelivery).toHaveBeenCalledTimes(1);
      const updated = (webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery);
      expect(updated.status).toBe('success');
      expect(updated.http_status).toBe(200);
    });

    it('marks delivery failed on 4xx (no retry)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'invalid',
      });
      await worker.deliverOne(baseDelivery);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('failed');
      expect(updated.attempt).toBe(1);
    });

    it('schedules retry on 5xx with backoff', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'down',
      });
      await worker.deliverOne(baseDelivery);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('retrying');
      expect(updated.attempt).toBe(2);
    });

    it('schedules retry on 429', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'too many',
      });
      await worker.deliverOne(baseDelivery);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('retrying');
    });

    it('gives up at max_attempts', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'error',
      });
      const exhausted = { ...baseDelivery, attempt: 3 }; // max_attempts == 3
      await worker.deliverOne(exhausted);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('gave_up');
    });

    it('marks failed when SSRF guard blocks the URL just before sending', async () => {
      webhooks.findByIdInternal = jest.fn(async () => ({
        ...baseWebhook,
        url: 'http://127.0.0.1/internal',
      }));
      await worker.deliverOne(baseDelivery);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('failed');
      expect(updated.error_message).toMatch(/ssrf/);
    });

    it('marks failed when the webhook definition is missing', async () => {
      webhooks.findByIdInternal = jest.fn(async () => null);
      await worker.deliverOne(baseDelivery);
      const updated = webhooks.updateDelivery.mock.calls[0][0] as WebhookDelivery;
      expect(updated.status).toBe('failed');
      expect(updated.error_message).toMatch(/not found/);
    });
  });

  describe('drainQueue', () => {
    it('processes every ready delivery in the batch', async () => {
      webhooks.findReadyDeliveries = jest.fn(async () => [
        baseDelivery,
        { ...baseDelivery, id: 'del_2' },
      ]);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'ok',
      });
      const processed = await worker.drainQueue(50);
      expect(processed).toBe(2);
    });

    it('returns 0 when nothing is ready', async () => {
      webhooks.findReadyDeliveries = jest.fn(async () => []);
      const processed = await worker.drainQueue(50);
      expect(processed).toBe(0);
    });

    it('routes Twenty-destination deliveries to the connector, not the generic POST', async () => {
      const twentyWebhook: WebhookDefinition = {
        ...baseWebhook,
        id: 'wh_t',
        url: 'https://crm.app.veridian.site',
        transform: { type: 'twenty' },
      };
      const dT = { ...baseDelivery, id: 'del_t', webhook_id: 'wh_t' };
      webhooks.findReadyDeliveries = jest.fn(async () => [dT]);
      webhooks.findByIdInternal = jest.fn(async (_id: string) => twentyWebhook);
      const flushSpy = jest
        .spyOn(worker, 'flushTwentyGroup')
        .mockResolvedValue(undefined);
      await worker.drainQueue(50);
      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(flushSpy.mock.calls[0][0].id).toBe('wh_t');
      expect(flushSpy.mock.calls[0][1].map((d) => d.id)).toEqual(['del_t']);
      // generic POST path never used for a Twenty destination
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('flushTwentyGroup — outcome persistence', () => {
    const twentyWebhook: WebhookDefinition = {
      ...baseWebhook,
      id: 'wh_t',
      url: 'https://crm.app.veridian.site',
      transform: { type: 'twenty' },
    };
    const mkDelivery = (id: string): WebhookDelivery => ({
      ...baseDelivery,
      id,
      webhook_id: 'wh_t',
      event_type: 'goal',
      request_body: JSON.stringify({ event_type: 'goal', goal_name: 'rdv_booked', user_id: 'a@b.com' }),
    });

    function connectorOutcome(over: Partial<{
      written: string[];
      orphans: string[];
      failed: string[];
      skipped: string[];
    }>) {
      return { written: [], orphans: [], failed: [], skipped: [], ...over };
    }

    it('marks written deliveries success', async () => {
      const connector = (worker as unknown as { twenty: TwentyConnectorService }).twenty;
      jest.spyOn(connector, 'flushBatch').mockResolvedValue(connectorOutcome({ written: ['x1'] }));
      await worker.flushTwentyGroup(twentyWebhook, [mkDelivery('x1')], new TwentyBudget());
      const updated = webhooks.updateDelivery.mock.calls.find((c) => (c[0] as WebhookDelivery).id === 'x1')![0] as WebhookDelivery;
      expect(updated.status).toBe('success');
    });

    it('marks skipped deliveries success no-op (never retried)', async () => {
      const connector = (worker as unknown as { twenty: TwentyConnectorService }).twenty;
      jest.spyOn(connector, 'flushBatch').mockResolvedValue(connectorOutcome({ skipped: ['x2'] }));
      await worker.flushTwentyGroup(twentyWebhook, [mkDelivery('x2')], new TwentyBudget());
      const updated = webhooks.updateDelivery.mock.calls.find((c) => (c[0] as WebhookDelivery).id === 'x2')![0] as WebhookDelivery;
      expect(updated.status).toBe('success');
      expect(updated.error_message).toMatch(/skipped/);
    });

    it('retries orphan deliveries (Person not yet imported)', async () => {
      const connector = (worker as unknown as { twenty: TwentyConnectorService }).twenty;
      jest.spyOn(connector, 'flushBatch').mockResolvedValue(connectorOutcome({ orphans: ['x3'] }));
      await worker.flushTwentyGroup(twentyWebhook, [mkDelivery('x3')], new TwentyBudget());
      const updated = webhooks.updateDelivery.mock.calls.find((c) => (c[0] as WebhookDelivery).id === 'x3')![0] as WebhookDelivery;
      expect(updated.status).toBe('retrying');
      expect(updated.attempt).toBe(2);
      expect(updated.error_message).toMatch(/orphan/);
    });

    it('marks failed group inactive without calling the connector', async () => {
      const connector = (worker as unknown as { twenty: TwentyConnectorService }).twenty;
      const flushSpy = jest.spyOn(connector, 'flushBatch');
      await worker.flushTwentyGroup({ ...twentyWebhook, active: false }, [mkDelivery('x4')], new TwentyBudget());
      expect(flushSpy).not.toHaveBeenCalled();
      const updated = webhooks.updateDelivery.mock.calls.find((c) => (c[0] as WebhookDelivery).id === 'x4')![0] as WebhookDelivery;
      expect(updated.status).toBe('failed');
      expect(updated.error_message).toMatch(/inactive/);
    });

    it('marks failed when the Twenty base URL is blocked by the SSRF guard', async () => {
      const connector = (worker as unknown as { twenty: TwentyConnectorService }).twenty;
      const flushSpy = jest.spyOn(connector, 'flushBatch');
      await worker.flushTwentyGroup({ ...twentyWebhook, url: 'http://127.0.0.1/' }, [mkDelivery('x5')], new TwentyBudget());
      expect(flushSpy).not.toHaveBeenCalled();
      const updated = webhooks.updateDelivery.mock.calls.find((c) => (c[0] as WebhookDelivery).id === 'x5')![0] as WebhookDelivery;
      expect(updated.status).toBe('failed');
      expect(updated.error_message).toMatch(/ssrf/);
    });
  });

  // ─── Single-leader gate (multi-instance double-POST guard) ──────────────
  // `findReadyDeliveries` is NOT an atomic claim on ClickHouse → correctness
  // relies on exactly one process draining the queue. The leader flag enforces
  // that: a non-leader replica must NEVER poll. Fail-safe default = leader.
  describe('single-leader gate (WEBHOOK_WORKER_LEADER)', () => {
    function makeWorker(leaderEnv: string | undefined): WebhookDeliveryWorker {
      const cfg = {
        get: (k: string) => {
          if (k === 'WEBHOOK_WORKER_LEADER') return leaderEnv;
          if (k === 'WEBHOOK_ALLOW_HTTP') return 'false';
          return undefined;
        },
      } as unknown as ConfigService;
      return new WebhookDeliveryWorker(
        webhooks,
        {} as WebhookTransformEngine,
        {} as SsrfGuard,
        cfg,
        {} as TwentyConnectorService,
      );
    }

    it('defaults to leader (drains) when the ENV is unset', async () => {
      const w = makeWorker(undefined);
      w.onModuleInit();
      const drainSpy = jest.spyOn(w, 'drainQueue').mockResolvedValue(0);
      await w.tick();
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('defaults to leader when the ENV is empty string', async () => {
      const w = makeWorker('');
      w.onModuleInit();
      const drainSpy = jest.spyOn(w, 'drainQueue').mockResolvedValue(0);
      await w.tick();
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('drains when WEBHOOK_WORKER_LEADER=true', async () => {
      const w = makeWorker('true');
      w.onModuleInit();
      const drainSpy = jest.spyOn(w, 'drainQueue').mockResolvedValue(0);
      await w.tick();
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT drain when WEBHOOK_WORKER_LEADER=false (non-leader replica)', async () => {
      const w = makeWorker('false');
      w.onModuleInit();
      const drainSpy = jest.spyOn(w, 'drainQueue').mockResolvedValue(0);
      await w.tick();
      expect(drainSpy).not.toHaveBeenCalled();
    });

    it('treats "FALSE"/" false " (case + whitespace) as non-leader', async () => {
      for (const env of ['FALSE', '  false  ', 'False']) {
        const w = makeWorker(env);
        w.onModuleInit();
        const drainSpy = jest.spyOn(w, 'drainQueue').mockResolvedValue(0);
        await w.tick();
        expect(drainSpy).not.toHaveBeenCalled();
      }
    });

    it('treats any non-"false" value as leader (fail-safe: only explicit false demotes)', async () => {
      // A typo like "no"/"0" must NOT silently disable delivery — only the exact
      // token "false" demotes. Anything else keeps the worker draining.
      for (const env of ['no', '0', 'off', 'yes']) {
        const w = makeWorker(env);
        w.onModuleInit();
        const drainSpy = jest.spyOn(w, 'drainQueue').mockResolvedValue(0);
        await w.tick();
        expect(drainSpy).toHaveBeenCalledTimes(1);
      }
    });
  });
});
