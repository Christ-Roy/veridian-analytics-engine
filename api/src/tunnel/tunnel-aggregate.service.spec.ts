import { TunnelAggregateService } from './tunnel-aggregate.service';
import { ExportService } from '../export/export.service';
import { UserEventRow } from '../export/dto/user-events-query.dto';

function row(partial: Partial<UserEventRow>): UserEventRow {
  return {
    id: 'e1',
    session_id: 's1',
    user_id: 'a@b.com',
    name: 'goal',
    path: '/',
    created_at: '2026-06-10 09:00:00.000',
    updated_at: '2026-06-10 09:00:00.000',
    referrer: '',
    referrer_domain: '',
    is_direct: false,
    landing_page: '',
    landing_domain: '',
    landing_path: '',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_term: '',
    utm_content: '',
    utm_id: '',
    utm_id_from: '',
    channel: '',
    channel_group: '',
    stm_1: '', stm_2: '', stm_3: '', stm_4: '', stm_5: '',
    stm_6: '', stm_7: '', stm_8: '', stm_9: '', stm_10: '',
    device: '', browser: '', browser_type: '', os: '',
    country: '', region: '', city: '', language: '', timezone: '',
    goal_name: 'rdv_booked',
    goal_value: 0,
    goal_timestamp: '2026-06-10 09:00:00.000',
    page_number: 0,
    duration: 0,
    max_scroll: 0,
    properties: {},
    ...partial,
  };
}

describe('TunnelAggregateService', () => {
  let service: TunnelAggregateService;
  let exportService: jest.Mocked<ExportService>;

  beforeEach(() => {
    exportService = { getUserEvents: jest.fn() } as unknown as jest.Mocked<ExportService>;
    service = new TunnelAggregateService(exportService);
  });

  it('defaults the window to last 48h when since/until omitted', async () => {
    exportService.getUserEvents.mockResolvedValue({ data: [], next_cursor: null, has_more: false });
    const before = Date.now();
    const res = await service.aggregate({ workspace_id: 'ws_a' });
    const until = Date.parse(res.window.until);
    const since = Date.parse(res.window.since);
    expect(until).toBeGreaterThanOrEqual(before);
    expect(until - since).toBe(48 * 60 * 60 * 1000);
    // first page is driven by `since`, not a cursor
    expect(exportService.getUserEvents.mock.calls[0][0]).toMatchObject({
      workspace_id: 'ws_a',
      since: res.window.since,
      until: res.window.until,
    });
  });

  it('aggregates a single page into the contract shape', async () => {
    exportService.getUserEvents.mockResolvedValue({
      data: [
        row({ name: 'screen_view', path: '/audit/x', max_scroll: 80 }),
        row({ goal_name: 'audit_cta_rdv' }),
      ],
      next_cursor: null,
      has_more: false,
    });
    const res = await service.aggregate({ workspace_id: 'ws_a', since: '2026-06-09T00:00:00Z' });
    expect(res.aggregates).toHaveLength(1);
    expect(res.aggregates[0]).toMatchObject({
      userId: 'a@b.com',
      auditViews: 1,
      auditScrollMax: 80,
      ctaClicks: 1,
      sessions: 1,
      identifiedByEmail: true,
    });
  });

  it('walks the cursor across pages and folds into complete aggregates', async () => {
    exportService.getUserEvents
      .mockResolvedValueOnce({
        data: [row({ goal_name: 'cta_click' })],
        next_cursor: 'CUR1',
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [row({ goal_name: 'cta_click' })],
        next_cursor: null,
        has_more: false,
      });
    const res = await service.aggregate({ workspace_id: 'ws_a', since: '2026-06-09T00:00:00Z' });
    // second call uses the cursor, not `since`
    expect(exportService.getUserEvents.mock.calls[1][0]).toMatchObject({ cursor: 'CUR1' });
    expect(exportService.getUserEvents.mock.calls[1][0]).not.toHaveProperty('since');
    // both pages merged → 2 CTA clicks for the same identity
    expect(res.aggregates).toHaveLength(1);
    expect(res.aggregates[0].ctaClicks).toBe(2);
  });

  it('passes the workspace_id straight through (multi-tenant scoping by the reader)', async () => {
    exportService.getUserEvents.mockResolvedValue({ data: [], next_cursor: null, has_more: false });
    await service.aggregate({ workspace_id: 'ws_other' });
    expect(exportService.getUserEvents.mock.calls[0][0].workspace_id).toBe('ws_other');
  });

  it('honours an explicit window', async () => {
    exportService.getUserEvents.mockResolvedValue({ data: [], next_cursor: null, has_more: false });
    const res = await service.aggregate({
      workspace_id: 'ws_a',
      since: '2026-06-01T00:00:00.000Z',
      until: '2026-06-02T00:00:00.000Z',
    });
    expect(res.window).toEqual({
      since: '2026-06-01T00:00:00.000Z',
      until: '2026-06-02T00:00:00.000Z',
    });
  });
});
