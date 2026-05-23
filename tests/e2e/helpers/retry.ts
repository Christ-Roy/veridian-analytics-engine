/**
 * Polling avec timeout — pour les opérations async ClickHouse / ingestion.
 *
 * ClickHouse a une latence d'écriture/lecture variable (1-5s). Les tests qui
 * font "POST event → expect query" doivent retry, jamais sleep en aveugle.
 */

export interface PollOptions {
  /** Timeout total (ms). Default: 30s. */
  timeoutMs?: number;
  /** Délai entre tentatives (ms). Default: 1s. */
  intervalMs?: number;
  /** Label pour message d'erreur. */
  label?: string;
}

/**
 * Retry une assertion async jusqu'à ce qu'elle passe ou que le timeout expire.
 *
 * @example
 *   await pollUntil(async () => {
 *     const r = await fetch(`${url}/events?session=${id}`);
 *     const data = await r.json();
 *     if (data.events.length === 0) throw new Error("no events yet");
 *     return data.events[0];
 *   }, { timeoutMs: 15_000, label: "ingest event" });
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: PollOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const label = opts.label ?? "condition";
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(intervalMs);
    }
  }
  throw new Error(
    `pollUntil(${label}) timeout after ${timeoutMs}ms — last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
