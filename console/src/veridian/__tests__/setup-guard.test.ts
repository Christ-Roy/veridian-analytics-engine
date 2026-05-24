import { describe, it, expect, vi } from 'vitest';
import { shouldBlockSetupAccess } from '../setup-guard';

/**
 * SECU P0 — `shouldBlockSetupAccess` doit fail-CLOSED.
 *
 * Bug d'origine (BUG-01, audit 2026-05-23) : la page `/setup` répondait
 * HTTP 200 publiquement sur prod (`analytics-engine.app.veridian.site/setup`)
 * alors que l'admin était déjà bootstrap. Le try/catch dans le `beforeLoad`
 * swallow le `throw redirect()` parce que les conditions du catch ne
 * reconnaissaient pas l'objet redirect de TanStack Router.
 *
 * Ce spec verrouille la logique : seul un 200 explicite avec
 * `setupCompleted: false` doit autoriser l'accès. Tout le reste = block.
 */

function mockResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('shouldBlockSetupAccess — fail-closed guard', () => {
  it('BLOCKS when API says setupCompleted=true (admin already bootstrap)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { setupCompleted: true }));

    const blocked = await shouldBlockSetupAccess(fetcher);

    expect(blocked).toBe(true);
  });

  it('ALLOWS access only when API says setupCompleted=false explicitly', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { setupCompleted: false }));

    const blocked = await shouldBlockSetupAccess(fetcher);

    expect(blocked).toBe(false);
  });

  it('BLOCKS when API returns 5xx (fail-closed on backend down)', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(503, null));

    const blocked = await shouldBlockSetupAccess(fetcher);

    expect(blocked).toBe(true);
  });

  it('BLOCKS when API returns 4xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(404, null));

    const blocked = await shouldBlockSetupAccess(fetcher);

    expect(blocked).toBe(true);
  });

  it('BLOCKS when fetch throws (network down)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const blocked = await shouldBlockSetupAccess(fetcher);

    expect(blocked).toBe(true);
  });

  it('BLOCKS when response JSON is invalid', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    } as unknown as Response);

    const blocked = await shouldBlockSetupAccess(fetcher);

    expect(blocked).toBe(true);
  });

  it('BLOCKS when setupCompleted is missing from response', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(200, {}));

    const blocked = await shouldBlockSetupAccess(fetcher);

    // setupCompleted !== false → block (fail-closed sur shape inattendue)
    expect(blocked).toBe(true);
  });

  it('BLOCKS when setupCompleted is non-boolean truthy', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { setupCompleted: 'true' }));

    const blocked = await shouldBlockSetupAccess(fetcher);

    // String "true" !== boolean false → block (strict equality)
    expect(blocked).toBe(true);
  });
});
