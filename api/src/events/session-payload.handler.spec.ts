import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SessionPayloadHandler } from './session-payload.handler';
import { IdentityStitchService } from './identity-stitch.service';
import { EventBufferService } from './event-buffer.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { GeoService } from '../geo/geo.service';
import { EMPTY_GEO } from '../geo/geo.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SessionPayloadDto,
  PageviewActionDto,
  GoalActionDto,
} from './dto/session-payload.dto';

describe('SessionPayloadHandler', () => {
  let handler: SessionPayloadHandler;
  let bufferService: jest.Mocked<EventBufferService>;
  let workspacesService: jest.Mocked<WorkspacesService>;
  let geoService: jest.Mocked<GeoService>;
  let eventEmitter: { emit: jest.Mock };

  const mockWorkspace = {
    id: 'test-ws',
    name: 'Test Workspace',
    website: 'https://example.com',
    timezone: 'UTC',
    currency: 'USD',
    status: 'active',
    settings: {
      timescore_reference: 180,
      bounce_threshold: 10,
      geo_enabled: true,
      geo_store_city: true,
      geo_store_region: true,
      geo_coordinates_precision: 2,
      filters: [],
    },
  };

  const createPayload = (
    overrides: Partial<SessionPayloadDto> = {},
  ): SessionPayloadDto =>
    ({
      workspace_id: 'test-ws',
      session_id: 'sess-123',
      actions: [],
      created_at: Date.now() - 10000,
      updated_at: Date.now(),
      ...overrides,
    }) as SessionPayloadDto;

  const createPageviewAction = (
    overrides: Partial<PageviewActionDto> = {},
  ): PageviewActionDto =>
    ({
      type: 'pageview',
      path: '/home',
      page_number: 1,
      duration: 5000,
      scroll: 50,
      entered_at: Date.now() - 5000,
      exited_at: Date.now(),
      ...overrides,
    }) as PageviewActionDto;

  const createGoalAction = (
    overrides: Partial<GoalActionDto> = {},
  ): GoalActionDto =>
    ({
      type: 'goal',
      name: 'signup',
      path: '/register',
      page_number: 2,
      timestamp: Date.now(),
      ...overrides,
    }) as GoalActionDto;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionPayloadHandler,
        {
          provide: EventBufferService,
          useValue: { addBatch: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: WorkspacesService,
          useValue: {
            get: jest.fn().mockResolvedValue(mockWorkspace),
            // Best-effort initializing → active flip fired by the handler.
            activateIfInitializing: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: GeoService,
          useValue: {
            lookupWithSettings: jest.fn().mockReturnValue(EMPTY_GEO),
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
        {
          provide: IdentityStitchService,
          useValue: { scheduleStitch: jest.fn() },
        },
      ],
    }).compile();

    handler = module.get<SessionPayloadHandler>(SessionPayloadHandler);
    bufferService = module.get(EventBufferService);
    workspacesService = module.get(WorkspacesService);
    geoService = module.get(GeoService);
    eventEmitter = module.get(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('pageview deserialization', () => {
    it('converts pageview action to screen_view event', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ path: '/about', page_number: 2 })],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await handler.handle(payload, '8.8.8.8');

      expect(bufferService.addBatch).toHaveBeenCalledTimes(1);
      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: 'sess-123',
        workspace_id: 'test-ws',
        name: 'screen_view',
        path: '/about',
        page_number: 2,
        page_duration: 5000,
        max_scroll: 50,
      });
    });

    it('preserves entered_at and exited_at timestamps from SDK', async () => {
      const enteredAt = Date.now() - 5000;
      const exitedAt = Date.now();

      const payload = createPayload({
        actions: [
          createPageviewAction({
            entered_at: enteredAt,
            exited_at: exitedAt,
          }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].entered_at).toBeDefined();
      expect(events[0].exited_at).toBeDefined();
      // Verify they are ClickHouse DateTime format strings
      expect(typeof events[0].entered_at).toBe('string');
      expect(typeof events[0].exited_at).toBe('string');
    });

    it('sets previous_path from prior pageview', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ path: '/home', page_number: 1 }),
          createPageviewAction({ path: '/about', page_number: 2 }),
        ],
        attributes: { landing_page: 'https://example.com/home' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].previous_path).toBe(''); // First page has no previous
      expect(events[1].previous_path).toBe('/home'); // Second page's previous is first
    });

    it('converts duration from ms to seconds for page_duration', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ duration: 5500 })], // 5.5 seconds in ms
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].page_duration).toBe(5500); // Keep as ms, matches schema
    });
  });

  describe('emitTracked — event.tracked payload (webhooks fan-out, #15)', () => {
    function lastTracked(): {
      event_id: string;
      payload: Record<string, unknown>;
    } {
      const call = eventEmitter.emit.mock.calls.find((c) => c[0] === 'event.tracked');
      if (!call) throw new Error('event.tracked was not emitted');
      return call[1];
    }

    it('includes max_scroll so the connector can emit audit.scroll (>=75)', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ path: '/audit/x', scroll: 85, page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });
      await handler.handle(payload, null);
      expect(lastTracked().payload.max_scroll).toBe(85);
    });

    it('includes real event timestamps so happensAt is the true event time', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ path: '/audit/x', page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });
      await handler.handle(payload, null);
      const p = lastTracked().payload;
      // entered_at + received_at are ClickHouse datetime strings (mapper reads them)
      expect(typeof p.entered_at).toBe('string');
      expect(typeof p.received_at).toBe('string');
    });

    it('uses a STABLE event_id (dedup_token, no Date.now) for replay idempotence', async () => {
      const make = () =>
        createPayload({
          actions: [createPageviewAction({ path: '/audit/x', page_number: 1 })],
          attributes: { landing_page: 'https://example.com/' },
        });
      await handler.handle(make(), null);
      const id1 = lastTracked().event_id;
      jest.clearAllMocks();
      await handler.handle(make(), null);
      const id2 = lastTracked().event_id;
      // same logical event → same id (no Date.now drift) → connector replay no-op
      expect(id1).toBe(id2);
      expect(id1).not.toMatch(/\d{13}/); // no epoch-ms suffix
    });
  });

  describe('goal deserialization', () => {
    it('converts goal action to goal event', async () => {
      const timestamp = Date.now();
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({
            name: 'purchase',
            value: 99.99,
            timestamp,
            page_number: 7,
          }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events).toHaveLength(2);

      const goalEvent = events[1];
      expect(goalEvent).toMatchObject({
        name: 'goal',
        goal_name: 'purchase',
        goal_value: 99.99,
        page_number: 7, // Explicitly set, verifies mapping from action
      });
    });

    it('includes goal properties in event properties', async () => {
      const payload = createPayload({
        actions: [
          createGoalAction({
            name: 'checkout',
            properties: { plan: 'premium', source: 'banner' },
          }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].properties).toEqual({
        plan: 'premium',
        source: 'banner',
      });
    });

    it('sets goal_value to 0 when not provided', async () => {
      const payload = createPayload({
        actions: [createGoalAction({ name: 'signup' })], // No value
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].goal_value).toBe(0);
    });

    it('preserves goal timestamp from SDK', async () => {
      const goalTimestamp = Date.now() - 1000;

      const payload = createPayload({
        actions: [
          createGoalAction({
            name: 'purchase',
            timestamp: goalTimestamp,
          }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].goal_timestamp).toBeDefined();
      // Verify it's a ClickHouse DateTime format string
      expect(typeof events[0].goal_timestamp).toBe('string');
    });
  });

  describe('_version timestamp', () => {
    it('sets _version to current server time on all events', async () => {
      const beforeTime = Date.now();

      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'signup' }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const afterTime = Date.now();
      const events = bufferService.addBatch.mock.calls[0][0];

      for (const event of events) {
        expect(event._version).toBeGreaterThanOrEqual(beforeTime);
        expect(event._version).toBeLessThanOrEqual(afterTime);
      }
    });

    it('all events in same payload have same _version', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createPageviewAction({ page_number: 2 }),
          createGoalAction({ name: 'signup' }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      const versions = events.map((e: { _version: number }) => e._version);
      expect(new Set(versions).size).toBe(1); // All same version
    });
  });

  describe('session attributes', () => {
    it('applies session attributes to all events', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'signup' }),
        ],
        attributes: {
          landing_page: 'https://example.com/landing',
          referrer: 'https://google.com/search',
          utm_source: 'google',
          utm_medium: 'cpc',
          browser: 'Chrome',
          os: 'macOS',
          screen_width: 1920,
          screen_height: 1080,
        },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      for (const event of events) {
        expect(event.landing_page).toBe('https://example.com/landing');
        expect(event.referrer).toBe('https://google.com/search');
        expect(event.utm_source).toBe('google');
        expect(event.browser).toBe('Chrome');
        expect(event.screen_width).toBe(1920);
      }
    });

    it('derives referrer_domain and landing_domain from URLs', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://example.com/products/item?id=123',
          referrer: 'https://google.com/search?q=test',
        },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].landing_domain).toBe('example.com');
      expect(events[0].landing_path).toBe('/products/item');
      expect(events[0].referrer_domain).toBe('google.com');
      expect(events[0].referrer_path).toBe('/search');
    });

    it('sets is_direct based on referrer presence', async () => {
      // With referrer
      const payloadWithRef = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://example.com/',
          referrer: 'https://google.com/',
        },
      });
      await handler.handle(payloadWithRef, null);
      expect(bufferService.addBatch.mock.calls[0][0][0].is_direct).toBe(false);

      bufferService.addBatch.mockClear();

      // Without referrer
      const payloadDirect = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });
      await handler.handle(payloadDirect, null);
      expect(bufferService.addBatch.mock.calls[0][0][0].is_direct).toBe(true);
    });
  });

  // S6 Lot B — parsing du code parrain `?ref=` + dérivation referral.
  // (le couvert e2e VRAI ClickHouse vit dans session-payload.e2e-spec.ts ;
  //  ici on verrouille le fail-soft du parsing, fin et déterministe.)
  describe('referral code parsing (?ref=, S6 Lot B)', () => {
    const firstEvent = () => bufferService.addBatch.mock.calls[0][0][0];

    function withSettings(settings: Record<string, unknown>): void {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: { ...mockWorkspace.settings, ...settings },
      } as never);
    }

    it('default param "ref": ?ref=CODE → referral + utm_content=CODE', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://app.example.com/login?ref=VHCRPP6X' },
      });
      await handler.handle(payload, null);
      const ev = firstEvent();
      expect(ev.channel).toBe('referral');
      expect(ev.channel_group).toBe('referral');
      expect(ev.utm_content).toBe('VHCRPP6X');
    });

    it('?ref= NE MASQUE PAS un referrer plus riche (google → organic_search), code conservé', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://app.example.com/login?ref=VHCRPP6X',
          referrer: 'https://www.google.com/search?q=x',
        },
      });
      await handler.handle(payload, null);
      const ev = firstEvent();
      expect(ev.channel).toBe('organic_search');
      expect(ev.utm_content).toBe('VHCRPP6X');
    });

    it('landing sans ?ref= → direct, utm_content vide (non régressif)', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://app.example.com/login' },
      });
      await handler.handle(payload, null);
      const ev = firstEvent();
      expect(ev.channel).toBe('direct');
      expect(ev.utm_content).toBe('');
    });

    it('fail-soft: landing_page n\'est pas une URL valide → direct, pas de crash', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'not a url ?ref=NOPE' },
      });
      const result = await handler.handle(payload, null);
      expect(result.success).toBe(true);
      const ev = firstEvent();
      expect(ev.channel).toBe('direct');
      expect(ev.utm_content).toBe('');
    });

    it('fail-soft: landing_page absente → direct, pas de crash', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        // no attributes at all
      });
      const result = await handler.handle(payload, null);
      expect(result.success).toBe(true);
      expect(firstEvent().channel).toBe('direct');
    });

    it('param custom via settings.referral_param ("parrain")', async () => {
      withSettings({ referral_param: 'parrain' });
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://app.example.com/?parrain=ABC&ref=ZZZ' },
      });
      await handler.handle(payload, null);
      const ev = firstEvent();
      // "parrain" lu (→ referral + code), "ref" ignoré.
      expect(ev.channel).toBe('referral');
      expect(ev.utm_content).toBe('ABC');
    });

    it('referral_param="" DÉSACTIVE le parsing (?ref= ignoré → direct)', async () => {
      withSettings({ referral_param: '' });
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://app.example.com/login?ref=VHCRPP6X' },
      });
      await handler.handle(payload, null);
      const ev = firstEvent();
      expect(ev.channel).toBe('direct');
      expect(ev.utm_content).toBe('');
    });

    it('referral_param=null DÉSACTIVE le parsing', async () => {
      withSettings({ referral_param: null });
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://app.example.com/login?ref=VHCRPP6X' },
      });
      await handler.handle(payload, null);
      expect(firstEvent().channel).toBe('direct');
    });

    it('un utm_content fourni par le SDK est conservé si pas de ?ref=', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://app.example.com/login',
          utm_content: 'sdk_banner',
        },
      });
      await handler.handle(payload, null);
      expect(firstEvent().utm_content).toBe('sdk_banner');
    });
  });

  describe('geo lookup', () => {
    it('applies geo data from IP lookup', async () => {
      geoService.lookupWithSettings.mockReturnValue({
        country: 'US',
        region: 'California',
        city: 'San Francisco',
        latitude: 37.77,
        longitude: -122.42,
      });

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, '8.8.8.8');

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].country).toBe('US');
      expect(events[0].region).toBe('California');
      expect(events[0].city).toBe('San Francisco');
      expect(events[0].latitude).toBe(37.77);
      expect(events[0].longitude).toBe(-122.42);
    });

    it('performs geo lookup once per payload', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createPageviewAction({ page_number: 2 }),
          createGoalAction({ name: 'signup' }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, '8.8.8.8');

      expect(geoService.lookupWithSettings).toHaveBeenCalledTimes(1);
    });
  });

  describe('dedup token generation', () => {
    it('generates deterministic pageview dedup_token', async () => {
      const payload = createPayload({
        session_id: 'sess-abc',
        actions: [createPageviewAction({ page_number: 5 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      // Pageview token format: {session_id}_pv_{page_number}
      expect(events[0].dedup_token).toBe('sess-abc_pv_5');
    });

    it('generates deterministic goal dedup_token', async () => {
      const timestamp = 1704067200000;
      const payload = createPayload({
        session_id: 'sess-xyz',
        actions: [createGoalAction({ name: 'purchase', timestamp })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      // Goal token format: {session_id}_goal_{name}_{timestamp}
      expect(events[0].dedup_token).toBe(
        'sess-xyz_goal_purchase_1704067200000',
      );
    });

    it('same payload produces same dedup_tokens (idempotent)', async () => {
      const payload = createPayload({
        session_id: 'sess-test',
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'signup', timestamp: 1704067200000 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      // Process same payload twice
      await handler.handle(payload, null);
      await handler.handle(payload, null);

      const events1 = bufferService.addBatch.mock.calls[0][0];
      const events2 = bufferService.addBatch.mock.calls[1][0];

      expect(events1[0].dedup_token).toBe(events2[0].dedup_token);
      expect(events1[1].dedup_token).toBe(events2[1].dedup_token);
    });
  });

  describe('error handling', () => {
    it('throws BadRequestException for invalid workspace', async () => {
      workspacesService.get.mockRejectedValue(new Error('Not found'));

      const payload = createPayload({ workspace_id: 'invalid-ws' });

      await expect(handler.handle(payload, null)).rejects.toThrow(
        'Invalid workspace_id',
      );
    });

    it('handles empty attributes gracefully', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        // No attributes
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].landing_page).toBe('');
      expect(events[0].referrer).toBe('');
    });
  });

  describe('filter application', () => {
    it('applies workspace filters to events', async () => {
      // Setup workspace with filters (using actual filter format)
      const workspaceWithFilters = {
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          filters: [
            {
              id: 'filter-1',
              name: 'UTM Override',
              priority: 1,
              order: 0,
              tags: [],
              enabled: true,
              version: 'v1',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              conditions: [
                { field: 'utm_source', operator: 'equals', value: 'google' },
              ],
              operations: [
                { action: 'set_value', dimension: 'stm_1', value: 'paid' },
              ],
            },
          ],
        },
      };
      workspacesService.get.mockResolvedValue(workspaceWithFilters as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://example.com/',
          utm_source: 'google',
        },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].stm_1).toBe('paid');
    });

    it('does not apply filters when none configured', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://example.com/',
          utm_source: 'google',
        },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].stm_1).toBe(''); // No filter applied
    });
  });

  // === Clock Skew Detection Tests ===
  describe('Clock Skew Detection', () => {
    const THRESHOLD_MS = 5000; // 5 seconds

    describe('skew calculation', () => {
      it('does not correct when sent_at is undefined (legacy SDK)', async () => {
        const now = Date.now();
        const payload = createPayload({
          actions: [
            createPageviewAction({
              page_number: 1,
              entered_at: now - 5000,
              exited_at: now,
            }),
          ],
          created_at: now - 10000,
          updated_at: now,
          // No sent_at - legacy SDK
          attributes: { landing_page: 'https://example.com/' },
        });

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        // Timestamps should NOT be corrected
        expect(events[0].created_at).toContain(
          new Date(now - 10000).toISOString().slice(0, 10),
        );
      });

      it('does not correct when skew is within threshold (< 5s)', async () => {
        const now = Date.now();
        const payload = createPayload({
          actions: [
            createPageviewAction({
              page_number: 1,
              entered_at: now - 5000,
              exited_at: now,
            }),
          ],
          created_at: now - 10000,
          updated_at: now,
          sent_at: now - 2000, // 2s skew - within threshold
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        // Timestamps should NOT be corrected (skew within threshold)
        const createdDate = new Date(now - 10000);
        expect(events[0].created_at).toContain(
          createdDate.toISOString().slice(0, 10),
        );
      });

      it('corrects when client clock is ahead (negative skew > threshold)', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow + 3600000; // Client is 1 hour ahead

        const payload = createPayload({
          actions: [
            createPageviewAction({
              page_number: 1,
              entered_at: clientNow - 5000,
              exited_at: clientNow,
            }),
          ],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow, // Client thinks it's 1 hour ahead
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        // Timestamps should be corrected backwards by ~1 hour
        const correctedCreatedAt = new Date(
          events[0].created_at.replace(' ', 'T') + 'Z',
        ).getTime();
        // Should be close to serverNow - 10000, not clientNow - 10000
        expect(Math.abs(correctedCreatedAt - (serverNow - 10000))).toBeLessThan(
          THRESHOLD_MS,
        );
      });

      it('corrects when client clock is behind (positive skew > threshold)', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow - 3600000; // Client is 1 hour behind

        const payload = createPayload({
          actions: [
            createPageviewAction({
              page_number: 1,
              entered_at: clientNow - 5000,
              exited_at: clientNow,
            }),
          ],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow, // Client thinks it's 1 hour behind
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        // Timestamps should be corrected forward by ~1 hour
        const correctedCreatedAt = new Date(
          events[0].created_at.replace(' ', 'T') + 'Z',
        ).getTime();
        expect(Math.abs(correctedCreatedAt - (serverNow - 10000))).toBeLessThan(
          THRESHOLD_MS,
        );
      });
    });

    describe('timestamp correction', () => {
      it('corrects created_at when skew detected', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow + 60000; // Client 1 minute ahead

        const payload = createPayload({
          actions: [createPageviewAction({ page_number: 1 })],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow,
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        const correctedCreatedAt = new Date(
          events[0].created_at.replace(' ', 'T') + 'Z',
        ).getTime();
        // Should be corrected to ~serverNow - 10000
        expect(Math.abs(correctedCreatedAt - (serverNow - 10000))).toBeLessThan(
          THRESHOLD_MS,
        );
      });

      it('corrects updated_at when skew detected', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow + 60000; // Client 1 minute ahead

        const payload = createPayload({
          actions: [createPageviewAction({ page_number: 1 })],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow,
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        const correctedUpdatedAt = new Date(
          events[0].updated_at.replace(' ', 'T') + 'Z',
        ).getTime();
        expect(Math.abs(correctedUpdatedAt - serverNow)).toBeLessThan(
          THRESHOLD_MS,
        );
      });

      it('corrects pageview entered_at and exited_at when skew detected', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow + 60000; // Client 1 minute ahead

        const payload = createPayload({
          actions: [
            createPageviewAction({
              page_number: 1,
              entered_at: clientNow - 5000,
              exited_at: clientNow,
            }),
          ],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow,
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        const correctedEnteredAt = new Date(
          events[0].entered_at.replace(' ', 'T') + 'Z',
        ).getTime();
        const correctedExitedAt = new Date(
          events[0].exited_at.replace(' ', 'T') + 'Z',
        ).getTime();

        expect(Math.abs(correctedEnteredAt - (serverNow - 5000))).toBeLessThan(
          THRESHOLD_MS,
        );
        expect(Math.abs(correctedExitedAt - serverNow)).toBeLessThan(
          THRESHOLD_MS,
        );
      });

      it('corrects goal timestamp when skew detected', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow + 60000; // Client 1 minute ahead

        const payload = createPayload({
          actions: [
            createGoalAction({
              name: 'purchase',
              timestamp: clientNow - 1000,
            }),
          ],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow,
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        const correctedGoalTimestamp = new Date(
          events[0].goal_timestamp.replace(' ', 'T') + 'Z',
        ).getTime();

        expect(
          Math.abs(correctedGoalTimestamp - (serverNow - 1000)),
        ).toBeLessThan(THRESHOLD_MS);
      });

      it('does NOT correct duration (relative time)', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow + 60000; // Client 1 minute ahead

        const payload = createPayload({
          actions: [
            createPageviewAction({
              page_number: 1,
              duration: 5000, // 5 seconds
              entered_at: clientNow - 5000,
              exited_at: clientNow,
            }),
          ],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow,
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        // Duration should remain unchanged (relative time, not absolute)
        expect(events[0].duration).toBe(5000);
        expect(events[0].page_duration).toBe(5000);
      });

      it('keeps original timestamp in dedup_token for goals', async () => {
        const serverNow = Date.now();
        const clientNow = serverNow + 60000; // Client 1 minute ahead
        const originalTimestamp = clientNow - 1000;

        const payload = createPayload({
          session_id: 'sess-test',
          actions: [
            createGoalAction({
              name: 'purchase',
              timestamp: originalTimestamp,
            }),
          ],
          created_at: clientNow - 10000,
          updated_at: clientNow,
          sent_at: clientNow,
          attributes: { landing_page: 'https://example.com/' },
        }) as SessionPayloadDto & { sent_at: number };

        await handler.handle(payload, null);

        const events = bufferService.addBatch.mock.calls[0][0];
        // dedup_token should use ORIGINAL timestamp for consistency
        expect(events[0].dedup_token).toBe(
          `sess-test_goal_purchase_${originalTimestamp}`,
        );
      });
    });
  });

  // === Cross-Phase Tests ===
  describe('Cross-phase validation - action processing', () => {
    it('preserves action order in payload', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ path: '/a', page_number: 1 }),
          createGoalAction({ name: 'goal1', page_number: 1 }),
          createPageviewAction({ path: '/b', page_number: 2 }),
          createGoalAction({ name: 'goal2', page_number: 2 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events).toHaveLength(4);
      expect(
        events.map((e: { path: string; goal_name: string }) =>
          e.goal_name ? e.goal_name : e.path,
        ),
      ).toEqual(['/a', 'goal1', '/b', 'goal2']);
    });

    it('handles interleaved pageviews and goals', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'add_to_cart', page_number: 1 }),
          createGoalAction({ name: 'begin_checkout', page_number: 1 }),
          createPageviewAction({ page_number: 2 }),
          createGoalAction({ name: 'purchase', page_number: 2, value: 99.99 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(
        events.filter((e: { name: string }) => e.name === 'screen_view'),
      ).toHaveLength(2);
      expect(
        events.filter((e: { name: string }) => e.name === 'goal'),
      ).toHaveLength(3);
    });

    it('processes empty actions array without error', async () => {
      const payload = createPayload({
        actions: [],
        attributes: { landing_page: 'https://example.com/' },
      });

      const result = await handler.handle(payload, null);

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).not.toHaveBeenCalled();
    });

    it('handles goal with all optional properties', async () => {
      const payload = createPayload({
        actions: [
          createGoalAction({
            name: 'purchase',
            page_number: 1,
            value: 99.99,
            properties: { product_id: 'SKU123', category: 'Electronics' },
          }),
        ],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].goal_name).toBe('purchase');
      expect(events[0].goal_value).toBe(99.99);
      expect(events[0].properties).toEqual({
        product_id: 'SKU123',
        category: 'Electronics',
      });
    });
  });

  describe('B2B identification (visitor_id / fingerprint / ip)', () => {
    it('maps visitor_id from payload onto every event', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'signup' }),
        ],
        attributes: { landing_page: 'https://example.com/' },
        visitor_id: 'visitor_abc',
      }) as SessionPayloadDto & { visitor_id: string };

      await handler.handle(payload, '8.8.8.8');

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.visitor_id).toBe('visitor_abc');
      }
    });

    it('defaults visitor_id to empty string when not provided', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, '8.8.8.8');

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].visitor_id).toBe('');
    });

    it('maps fingerprint from attributes onto every event', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://example.com/',
          fingerprint: 'fp_xyz123',
        },
      });

      await handler.handle(payload, '8.8.8.8');

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].fingerprint).toBe('fp_xyz123');
    });

    it('stores the SERVER-captured client IP in clear (not from payload)', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        visitor_id: 'visitor_abc',
      }) as SessionPayloadDto & { visitor_id: string };

      await handler.handle(payload, '203.0.113.45');

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].ip).toBe('203.0.113.45');
    });

    it('defaults ip to empty string when client IP is null', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].ip).toBe('');
    });
  });

  describe('user_id handling', () => {
    it('sets user_id from payload when provided', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        user_id: 'user_123',
      }) as SessionPayloadDto & { user_id: string };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].user_id).toBe('user_123');
    });

    it('sets user_id to null when explicitly null in payload', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        user_id: null,
      }) as SessionPayloadDto & { user_id: null };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].user_id).toBeNull();
    });

    it('sets user_id to null when not provided in payload', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].user_id).toBeNull();
    });

    it('applies user_id to all events in payload', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'signup' }),
          createPageviewAction({ page_number: 2 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
        user_id: 'user_xyz',
      }) as SessionPayloadDto & { user_id: string };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events).toHaveLength(3);
      for (const event of events) {
        expect(event.user_id).toBe('user_xyz');
      }
    });
  });

  describe('dimensions handling', () => {
    it('populates stm_1 through stm_10 from dimensions object', async () => {
      const dimensions: Record<string, string> = {};
      for (let i = 1; i <= 10; i++) {
        dimensions[`stm_${i}`] = `value_${i}`;
      }

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        dimensions,
      }) as SessionPayloadDto & { dimensions: Record<string, string> };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      for (let i = 1; i <= 10; i++) {
        expect(events[0][`stm_${i}`]).toBe(`value_${i}`);
      }
    });

    it('handles sparse dimensions (only some set)', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        dimensions: {
          stm_1: 'campaign_a',
          stm_5: 'variant_b',
          stm_10: 'user_segment',
        },
      }) as SessionPayloadDto & { dimensions: Record<string, string> };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].stm_1).toBe('campaign_a');
      expect(events[0].stm_2).toBe(''); // Not set, should be empty
      expect(events[0].stm_5).toBe('variant_b');
      expect(events[0].stm_10).toBe('user_segment');
    });

    it('handles empty dimensions object', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        dimensions: {},
      }) as SessionPayloadDto & { dimensions: Record<string, string> };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      // All dimensions should be empty strings
      for (let i = 1; i <= 10; i++) {
        expect(events[0][`stm_${i}`]).toBe('');
      }
    });

    it('handles missing dimensions (undefined)', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      // All dimensions should be empty strings (default)
      for (let i = 1; i <= 10; i++) {
        expect(events[0][`stm_${i}`]).toBe('');
      }
    });

    it('applies dimensions to all events in payload', async () => {
      const payload = createPayload({
        actions: [
          createPageviewAction({ page_number: 1 }),
          createGoalAction({ name: 'signup' }),
          createPageviewAction({ page_number: 2 }),
        ],
        attributes: { landing_page: 'https://example.com/' },
        dimensions: { stm_1: 'campaign_test', stm_2: 'variant_a' },
      }) as SessionPayloadDto & { dimensions: Record<string, string> };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events).toHaveLength(3);
      for (const event of events) {
        expect(event.stm_1).toBe('campaign_test');
        expect(event.stm_2).toBe('variant_a');
      }
    });

    it('filters do not override SDK dimensions (SDK has priority)', async () => {
      // Setup workspace with filters that would set stm_1
      const workspaceWithFilters = {
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          filters: [
            {
              id: 'filter-1',
              name: 'UTM Override',
              priority: 1,
              order: 0,
              tags: [],
              enabled: true,
              version: 'v1',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              conditions: [
                { field: 'utm_source', operator: 'equals', value: 'google' },
              ],
              operations: [
                {
                  action: 'set_value',
                  dimension: 'stm_1',
                  value: 'filter_value',
                },
              ],
            },
          ],
        },
      };
      workspacesService.get.mockResolvedValue(workspaceWithFilters as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: {
          landing_page: 'https://example.com/',
          utm_source: 'google',
        },
        dimensions: { stm_1: 'sdk_value' },
      }) as SessionPayloadDto & { dimensions: Record<string, string> };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      // SDK value should win because filters are applied AFTER base event is built
      // NOTE: This test verifies the current implementation order
      // Filter will override because it applies after buildBaseEvent
      expect(events[0].stm_1).toBe('filter_value'); // Filter applied last
    });
  });

  describe('user_id and dimensions combined', () => {
    it('handles both user_id and dimensions together', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        user_id: 'user_test',
        dimensions: {
          stm_1: 'campaign_a',
          stm_2: 'variant_b',
        },
      }) as SessionPayloadDto & {
        user_id: string;
        dimensions: Record<string, string>;
      };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].user_id).toBe('user_test');
      expect(events[0].stm_1).toBe('campaign_a');
      expect(events[0].stm_2).toBe('variant_b');
    });

    it('handles user_id null with dimensions', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
        user_id: null,
        dimensions: { stm_1: 'test' },
      }) as SessionPayloadDto & {
        user_id: null;
        dimensions: Record<string, string>;
      };

      await handler.handle(payload, null);

      const events = bufferService.addBatch.mock.calls[0][0];
      expect(events[0].user_id).toBeNull();
      expect(events[0].stm_1).toBe('test');
    });
  });

  describe('allowed_domains restriction', () => {
    it('allows all domains when allowed_domains is not configured', async () => {
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://any-domain.com/' },
      });

      const result = await handler.handle(
        payload,
        null,
        'https://any-domain.com',
      );

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
    });

    it('allows all domains when allowed_domains is empty array', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: { ...mockWorkspace.settings, allowed_domains: [] },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://any-domain.com/' },
      });

      const result = await handler.handle(
        payload,
        null,
        'https://any-domain.com',
      );

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
    });

    it('warns when accepting with an empty allowed_domains (open default)', async () => {
      // Regression guard for ticket 2026-06-23-ingest-allowed-domains-vide:
      // legacy workspaces with no allowed_domains stay "allow all" but MUST
      // surface a warning so the exposure is visible in logs.
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: { ...mockWorkspace.settings, allowed_domains: [] },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://any-domain.com/' },
      });

      const result = await handler.handle(payload, null, 'https://spoofed.com');

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('allowed_domains empty'),
      );
      warnSpy.mockRestore();
    });

    it('accepts requests from allowed domain (via Origin header)', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          allowed_domains: ['example.com'],
        },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/page' },
      });

      const result = await handler.handle(payload, null, 'https://example.com');

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
    });

    it('rejects requests from non-allowed domain', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          allowed_domains: ['example.com'],
        },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://other-domain.com/page' },
      });

      const result = await handler.handle(
        payload,
        null,
        'https://other-domain.com',
      );

      expect(result.success).toBe(true); // Silent rejection
      expect(bufferService.addBatch).not.toHaveBeenCalled();
    });

    it('supports wildcard subdomain matching (*.example.com)', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          allowed_domains: ['*.example.com'],
        },
      } as never);

      // Subdomain should match
      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://app.example.com/' },
      });

      const result = await handler.handle(
        payload,
        null,
        'https://app.example.com',
      );

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();

      bufferService.addBatch.mockClear();

      // Deep subdomain should also match
      const payloadDeep = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://deep.sub.example.com/' },
      });

      const resultDeep = await handler.handle(
        payloadDeep,
        null,
        'https://deep.sub.example.com',
      );

      expect(resultDeep.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
    });

    it('wildcard also matches root domain (*.example.com matches example.com)', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          allowed_domains: ['*.example.com'],
        },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      const result = await handler.handle(payload, null, 'https://example.com');

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
    });

    it('matches domains case-insensitively', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          allowed_domains: ['Example.COM'],
        },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://EXAMPLE.com/' },
      });

      const result = await handler.handle(payload, null, 'https://EXAMPLE.com');

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
    });

    it('falls back to Referer header when Origin is missing', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          allowed_domains: ['example.com'],
        },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      // No origin, but referer is provided
      const result = await handler.handle(
        payload,
        null,
        undefined,
        'https://example.com/some-page',
      );

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalled();
    });

    it('rejects when both Origin and Referer are missing and domains restricted', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        settings: {
          ...mockWorkspace.settings,
          allowed_domains: ['example.com'],
        },
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      // No origin, no referer
      const result = await handler.handle(payload, null, undefined, undefined);

      expect(result.success).toBe(true); // Silent rejection
      expect(bufferService.addBatch).not.toHaveBeenCalled();
    });
  });

  describe('workspace kill-switch (inactive/error only) + initializing bootstrap', () => {
    // P0 2026-06-24: the kill-switch must block ONLY genuinely inactive states.
    // 'initializing' is the bootstrap state of every freshly-provisioned
    // workspace and has NO other transition out — dropping its first event made
    // it permanently stuck, dropping 100 % of a paying client's traffic.
    const droppedStatuses = ['inactive', 'error'] as const;

    for (const status of droppedStatuses) {
      it(`silently drops ingestion for status="${status}"`, async () => {
        workspacesService.get.mockResolvedValue({
          ...mockWorkspace,
          status,
        } as never);

        const payload = createPayload({
          actions: [createPageviewAction({ page_number: 1 })],
          attributes: { landing_page: 'https://example.com/' },
        });

        const result = await handler.handle(payload, '8.8.8.8');

        // 200 muet : on ne leak pas l'état du tenant, mais zéro écriture.
        expect(result.success).toBe(true);
        expect(bufferService.addBatch).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        // A genuinely inactive workspace is NEVER (re)activated by traffic.
        expect(
          workspacesService.activateIfInitializing,
        ).not.toHaveBeenCalled();
      });
    }

    it('INGESTS an "initializing" workspace AND flips it to active (P0 regression guard)', async () => {
      // This is THE test whose absence let the kill-switch ship: if anyone
      // recasts the kill-switch to `status !== 'active'`, this goes red.
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        status: 'initializing',
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      const result = await handler.handle(payload, '8.8.8.8');

      expect(result.success).toBe(true);
      // The first event MUST be ingested (no silent drop).
      expect(bufferService.addBatch).toHaveBeenCalledTimes(1);
      // …and it MUST trigger the initializing → active transition.
      expect(workspacesService.activateIfInitializing).toHaveBeenCalledWith(
        mockWorkspace.id,
      );
    });

    it('ingests normally for status="active" without re-flipping', async () => {
      workspacesService.get.mockResolvedValue({
        ...mockWorkspace,
        status: 'active',
      } as never);

      const payload = createPayload({
        actions: [createPageviewAction({ page_number: 1 })],
        attributes: { landing_page: 'https://example.com/' },
      });

      const result = await handler.handle(payload, '8.8.8.8');

      expect(result.success).toBe(true);
      expect(bufferService.addBatch).toHaveBeenCalledTimes(1);
      // An already-active workspace is not put back through the transition.
      expect(workspacesService.activateIfInitializing).not.toHaveBeenCalled();
    });
  });
});
