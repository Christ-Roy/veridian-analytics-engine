import { TwentyClient, TwentyClientConfig, TimelineActivityInput } from './twenty-client';

const BASE = 'https://crm.test.veridian.site';

function makeClient(over: Partial<TwentyClientConfig> = {}): TwentyClient {
  return new TwentyClient({
    baseUrl: BASE,
    bearer: 'tok_abc',
    dryRun: false,
    timeoutMs: 1000,
    ...over,
  });
}

describe('TwentyClient', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function ok(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }
  function err(status: number, text = 'boom'): Response {
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => text,
    } as unknown as Response;
  }

  describe('Person resolution (§4c.1)', () => {
    it('resolveByEmail builds emails.primaryEmail filter', async () => {
      fetchMock.mockResolvedValue(ok({ data: { people: [{ id: 'p1', doNotContact: false }] } }));
      const person = await makeClient().resolveByEmail('robert@veridian.site');
      expect(person).toEqual({ id: 'p1', doNotContact: false });
      const calledUrl = new URL(fetchMock.mock.calls[0][0]);
      expect(calledUrl.pathname).toBe('/rest/people');
      expect(calledUrl.searchParams.get('filter')).toBe(
        'emails.primaryEmail[eq]:"robert@veridian.site"',
      );
      expect(calledUrl.searchParams.get('limit')).toBe('1');
    });

    it('resolveBySlug builds auditSlug filter', async () => {
      fetchMock.mockResolvedValue(ok({ data: { people: [{ id: 'p2', doNotContact: true }] } }));
      const person = await makeClient().resolveBySlug('monsite-Ab3x');
      expect(person).toEqual({ id: 'p2', doNotContact: true });
      const calledUrl = new URL(fetchMock.mock.calls[0][0]);
      expect(calledUrl.searchParams.get('filter')).toBe('auditSlug[eq]:"monsite-Ab3x"');
    });

    it('resolvePerson branches on identity shape (@ → email, else slug)', async () => {
      fetchMock.mockResolvedValue(ok({ data: { people: [{ id: 'p1' }] } }));
      await makeClient().resolvePerson('a@b.com');
      expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('filter')).toContain(
        'emails.primaryEmail',
      );
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(ok({ data: { people: [{ id: 'p2' }] } }));
      await makeClient().resolvePerson('some-slug');
      expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('filter')).toContain('auditSlug');
    });

    it('returns null when no Person matches (orphan)', async () => {
      fetchMock.mockResolvedValue(ok({ data: { people: [] } }));
      expect(await makeClient().resolveByEmail('nobody@x.com')).toBeNull();
    });

    it('escapes double quotes in the identity', async () => {
      fetchMock.mockResolvedValue(ok({ data: { people: [] } }));
      await makeClient().resolveBySlug('a"b');
      expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('filter')).toBe(
        'auditSlug[eq]:"a\\"b"',
      );
    });

    it('throws on a non-ok resolve response', async () => {
      fetchMock.mockResolvedValue(err(500));
      await expect(makeClient().resolveByEmail('a@b.com')).rejects.toThrow('Twenty resolve 500');
    });

    it('READS stay real even in DRY_RUN', async () => {
      fetchMock.mockResolvedValue(ok({ data: { people: [{ id: 'p9' }] } }));
      const person = await makeClient({ dryRun: true }).resolveByEmail('a@b.com');
      expect(person?.id).toBe('p9');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('batchTimeline (§4c.2)', () => {
    const items: TimelineActivityInput[] = [
      { id: 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee', name: 'audit.rdv', happensAt: '2026-06-10T09:00:00.000Z', targetPersonId: 'p1', properties: {} },
    ];

    it('POSTs to /rest/batch/timelineActivities, stamps createdBy.source=API + the deterministic id', async () => {
      fetchMock.mockResolvedValue(ok({}));
      await makeClient().batchTimeline(items);
      const [url, init] = fetchMock.mock.calls[0];
      expect(new URL(url).pathname).toBe('/rest/batch/timelineActivities');
      expect(init.method).toBe('POST');
      const sent = JSON.parse(init.body);
      expect(sent[0].createdBy).toEqual({ source: 'API' });
      expect(sent[0].name).toBe('audit.rdv');
      // the deterministic id MUST be forwarded — it is what makes a replay idempotent
      expect(sent[0].id).toBe('aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee');
    });

    it('treats a 409 (duplicate id) as a no-op success (exactly-once on replay)', async () => {
      fetchMock.mockResolvedValue(err(409, 'duplicate'));
      // must NOT throw — a 409 means the activity already exists
      await expect(makeClient().batchTimeline(items)).resolves.toBeUndefined();
    });

    it('treats a 400 "A duplicate entry was detected" as a no-op (real Twenty REPLAY, #12)', async () => {
      // The real Twenty returns 400 (not 409) on a duplicate deterministic id.
      fetchMock.mockResolvedValue(err(400, '{"messages":["A duplicate entry was detected"]}'));
      await expect(makeClient().batchTimeline(items)).resolves.toBeUndefined();
    });

    it('matches "duplicate" case-insensitively in the 400 body', async () => {
      fetchMock.mockResolvedValue(err(400, 'DUPLICATE record'));
      await expect(makeClient().batchTimeline(items)).resolves.toBeUndefined();
    });

    it('still THROWS on a 400 that is NOT a duplicate (real error)', async () => {
      fetchMock.mockResolvedValue(err(400, 'invalid happensAt format'));
      await expect(makeClient().batchTimeline(items)).rejects.toThrow('Twenty batchTimeline 400');
    });

    it('is a no-op for an empty batch', async () => {
      await makeClient().batchTimeline([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a batch larger than 60', async () => {
      const big = Array.from({ length: 61 }, () => items[0]);
      await expect(makeClient().batchTimeline(big)).rejects.toThrow('> 60');
    });

    it('DRY_RUN logs and does NOT POST', async () => {
      await makeClient({ dryRun: true }).batchTimeline(items);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws on a non-ok batch response', async () => {
      fetchMock.mockResolvedValue(err(400, 'bad ts'));
      await expect(makeClient().batchTimeline(items)).rejects.toThrow('Twenty batchTimeline 400');
    });
  });

  describe('multi-tenant isolation', () => {
    it('uses the per-instance baseUrl + bearer (no shared state)', async () => {
      fetchMock.mockResolvedValue(ok({ data: { people: [] } }));
      const a = new TwentyClient({ baseUrl: 'https://a.veridian.site', bearer: 'TA', dryRun: false });
      const b = new TwentyClient({ baseUrl: 'https://b.veridian.site', bearer: 'TB', dryRun: false });
      await a.resolveByEmail('x@a.com');
      await b.resolveByEmail('y@b.com');
      expect(new URL(fetchMock.mock.calls[0][0]).host).toBe('a.veridian.site');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer TA');
      expect(new URL(fetchMock.mock.calls[1][0]).host).toBe('b.veridian.site');
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer TB');
    });
  });
});
