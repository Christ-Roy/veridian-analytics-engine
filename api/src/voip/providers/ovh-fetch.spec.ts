import { fetchOvhCdr } from './ovh';
import type { OvhCreds } from '../voip.providers';

const creds: OvhCreds = {
  applicationKey: 'app',
  applicationSecret: 'secret',
  consumerKey: 'consumer',
  endpoint: 'ovh-eu',
};

/**
 * Tiny fake fetch router for the OVH API surface. Routes by URL suffix:
 *   /auth/time                                  → server epoch (text)
 *   /telephony                                  → [billingAccount]
 *   /telephony/{ba}/service                     → [serviceName]
 *   …/voiceConsumption                          → list of consumption ids
 *   …/voiceConsumption/{id}                      → consumption detail
 */
function makeFetch(opts: {
  consumptionIds: number[];
  detailFor: (id: number) => Record<string, unknown>;
  onAuthTime?: () => void;
}): typeof fetch {
  const text = (s: string) =>
    ({ ok: true, status: 200, text: async () => s, json: async () => s }) as unknown as Response;
  const json = (v: unknown) =>
    ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) }) as unknown as Response;

  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/auth/time')) {
      opts.onAuthTime?.();
      return text(String(Math.floor(Date.now() / 1000)));
    }
    if (url.endsWith('/telephony')) return json(['ba-1']);
    if (url.endsWith('/service')) return json(['line-1']);
    if (url.endsWith('/voiceConsumption')) return json(opts.consumptionIds);
    const m = url.match(/\/voiceConsumption\/(\d+)$/);
    if (m) return json(opts.detailFor(Number(m[1])));
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

describe('fetchOvhCdr — cap after date sort (recent calls kept)', () => {
  it('keeps the most recent consumption ids when the list exceeds the cap', async () => {
    // 2100 ids, oldest first (low id = old). Recent calls have HIGH ids.
    // The window keeps only those whose creationDatetime is inside [since, now].
    const ids = Array.from({ length: 2100 }, (_, i) => i + 1);
    const now = Date.now();
    const requestedDetailIds: number[] = [];
    const fetchImpl = makeFetch({
      consumptionIds: ids,
      detailFor: (id) => {
        requestedDetailIds.push(id);
        // High id → recent (today). Low id → 30 days ago (outside the window).
        const ageDays = id > 2000 ? 0 : 30;
        return {
          consumptionId: id,
          wayType: 'incoming',
          called: '+33177123456',
          duration: 30,
          creationDatetime: new Date(
            now - ageDays * 24 * 60 * 60 * 1000,
          ).toISOString(),
        };
      },
    });

    const since = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const calls = await fetchOvhCdr(creds, { since, fetchImpl });

    // The 100 recent ids (2001..2100) must ALL be detail-fetched (not dropped
    // by the cap), proving the cap is applied AFTER sorting by recency.
    for (let id = 2001; id <= 2100; id++) {
      expect(requestedDetailIds).toContain(id);
    }
    // And the recent calls end up in the result (inside the date window).
    expect(calls).toHaveLength(100);
    // The oldest id (1) — outside both the cap window AND the date window —
    // must NOT have been fetched (cap dropped it).
    expect(requestedDetailIds).not.toContain(1);
  });
});

describe('fetchOvhCdr — periodic re-signature on long pulls', () => {
  it('re-fetches /auth/time when the signing timestamp goes stale', async () => {
    jest.useFakeTimers();
    try {
      let authTimeCalls = 0;
      // Two consumption ids; on the detail call for the first one, jump the
      // fake clock past the re-sign interval so the 2nd GET re-signs.
      const fetchImpl = makeFetch({
        consumptionIds: [10, 20],
        onAuthTime: () => {
          authTimeCalls++;
        },
        detailFor: (id) => {
          if (id === 10) {
            // advance 25s > OVH_RESIGN_INTERVAL_MS (20s)
            jest.setSystemTime(Date.now() + 25_000);
          }
          return {
            consumptionId: id,
            wayType: 'incoming',
            called: '+33177123456',
            duration: 10,
            creationDatetime: new Date().toISOString(),
          };
        },
      });

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await fetchOvhCdr(creds, { since, fetchImpl });

      // Initial /auth/time + at least one re-fetch after the clock jump.
      expect(authTimeCalls).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
