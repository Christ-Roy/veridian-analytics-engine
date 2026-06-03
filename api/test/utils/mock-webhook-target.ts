/**
 * Mock HTTP server used by the webhooks e2e suite.
 *
 * Listens on a random port (`port=0`) and records every received request.
 * Behavior is configurable on the fly via `setBehavior()` so each test can
 * drive its scenario (200 / 4xx / 5xx / delay) without restarting.
 *
 * NEVER ship outside the `test/` tree — this is a test fixture only.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

export interface MockTargetBehavior {
  status?: number;
  body?: string;
  /** Delay before responding (ms). Useful to simulate timeouts. */
  delayMs?: number;
  /** Drop the connection after receiving the body (simulates network err). */
  dropConnection?: boolean;
}

export interface MockWebhookTarget {
  url: string;
  setBehavior(b: MockTargetBehavior): void;
  requests: ReceivedRequest[];
  reset(): void;
  close(): Promise<void>;
}

export async function startMockWebhookTarget(): Promise<MockWebhookTarget> {
  const requests: ReceivedRequest[] = [];
  let behavior: MockTargetBehavior = { status: 200, body: '{"ok":true}' };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const headerEntries: [string, string][] = [];
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headerEntries.push([k, v]);
        else if (Array.isArray(v)) headerEntries.push([k, v.join(',')]);
      }
      requests.push({
        method: req.method ?? 'POST',
        path: req.url ?? '/',
        headers: Object.fromEntries(headerEntries),
        body: Buffer.concat(chunks).toString('utf8'),
        receivedAt: Date.now(),
      });

      const handle = () => {
        if (behavior.dropConnection) {
          req.socket.destroy();
          return;
        }
        res.statusCode = behavior.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(behavior.body ?? '');
      };
      if (behavior.delayMs && behavior.delayMs > 0) {
        setTimeout(handle, behavior.delayMs);
      } else {
        handle();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    setBehavior(b: MockTargetBehavior) {
      behavior = { ...behavior, ...b };
    },
    requests,
    reset() {
      requests.length = 0;
      behavior = { status: 200, body: '{"ok":true}' };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
