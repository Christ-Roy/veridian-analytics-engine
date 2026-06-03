import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDispatcherService, TrackedEventPayload } from './webhook-dispatcher.service';
import { WebhooksService } from './webhooks.service';
import { WebhookFilterEngine } from './webhook-filter-engine';
import { WebhookDefinition, DEFAULT_RETRY_CONFIG } from './entities/webhook-definition.entity';

function mkWebhook(overrides: Partial<WebhookDefinition> = {}): WebhookDefinition {
  return {
    id: 'wh_1',
    workspace_id: 'ws_a',
    name: 'unit',
    url: 'https://x.example.com',
    active: true,
    auth_type: 'none',
    auth_secret_encrypted: '',
    events: [],
    filters: [],
    transform: null,
    retry_config: DEFAULT_RETRY_CONFIG,
    created_at: '2026-06-03 12:00:00.000',
    updated_at: '2026-06-03 12:00:00.000',
    deleted_at: null,
    ...overrides,
  };
}

const event: TrackedEventPayload = {
  workspace_id: 'ws_a',
  event_type: 'screen_view',
  event_id: 'evt_abc',
  payload: { path: '/audit', utm: { source: 'google_ads' } },
};

describe('WebhookDispatcherService', () => {
  let dispatcher: WebhookDispatcherService;
  let webhooks: jest.Mocked<WebhooksService>;

  beforeEach(async () => {
    webhooks = {
      findActive: jest.fn(),
      enqueueDelivery: jest.fn(async () => ({ id: 'del_1' } as never)),
    } as unknown as jest.Mocked<WebhooksService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        { provide: WebhooksService, useValue: webhooks },
        WebhookFilterEngine,
      ],
    }).compile();
    dispatcher = module.get(WebhookDispatcherService);
  });

  it('enqueues a delivery when filters match', async () => {
    webhooks.findActive = jest.fn(async () => [
      mkWebhook({
        events: ['screen_view'],
        filters: [{ field: 'utm.source', op: 'equals', value: 'google_ads' }],
      }),
    ]);
    await dispatcher.dispatchInternal(event);
    expect(webhooks.enqueueDelivery).toHaveBeenCalledTimes(1);
  });

  it('skips webhooks whose event_type filter excludes the event', async () => {
    webhooks.findActive = jest.fn(async () => [mkWebhook({ events: ['goal'] })]);
    await dispatcher.dispatchInternal(event);
    expect(webhooks.enqueueDelivery).not.toHaveBeenCalled();
  });

  it('skips webhooks whose filters do not match', async () => {
    webhooks.findActive = jest.fn(async () => [
      mkWebhook({
        events: ['screen_view'],
        filters: [{ field: 'utm.source', op: 'equals', value: 'facebook' }],
      }),
    ]);
    await dispatcher.dispatchInternal(event);
    expect(webhooks.enqueueDelivery).not.toHaveBeenCalled();
  });

  it('handles workspaces with no webhooks (no-op)', async () => {
    webhooks.findActive = jest.fn(async () => []);
    await dispatcher.dispatchInternal(event);
    expect(webhooks.enqueueDelivery).not.toHaveBeenCalled();
  });

  it('multi-tenant: only ws_a webhooks are queried', async () => {
    webhooks.findActive = jest.fn(async () => []);
    await dispatcher.dispatchInternal(event);
    expect(webhooks.findActive).toHaveBeenCalledWith('ws_a');
  });

  it('does not throw when an underlying error occurs (fail-soft)', async () => {
    webhooks.findActive = jest.fn(async () => {
      throw new Error('clickhouse down');
    });
    await expect(dispatcher.dispatch(event)).resolves.toBeUndefined();
  });
});
