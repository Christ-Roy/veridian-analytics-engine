import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Resolver signature — a thin slice of `dns.lookup` we can inject in tests.
 * `all: true` so we validate EVERY address the hostname resolves to (a name
 * can return both a public and a private record).
 */
export type DnsAllResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

/** Promisified `dns.lookup(host, { all: true })` — the production resolver. */
const defaultResolver: DnsAllResolver = (hostname: string) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

/**
 * Shared SSRF allowlist — cf PATTERNS-WEBHOOKS.md §9.
 *
 * Used by every module that performs an outbound `fetch` toward a
 * caller-controlled URL: webhook delivery AND the public `tools/`
 * endpoints (websiteMeta / favicon).
 *
 * Refuses (raises ForbiddenException with code FORBIDDEN_TARGET):
 * - localhost / loopback / `0.0.0.0`
 * - RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 * - Link-local 169.254/16 (cloud metadata!)
 * - Carrier-grade NAT 100.64/10
 * - IPv6 loopback / unique-local / link-local / IPv4-mapped private
 * - non-HTTPS scheme when allowHttp is not set (code INVALID_URL)
 * - URLs targeting the engine itself (anti-loop guard)
 *
 * Two layers of defence:
 *   1. `assertSafeUrl()`  — SYNC, literal-hostname check. Run at CRUD time
 *      (create/update) for instant feedback. Cheap, no DNS.
 *   2. `assertSafeUrlResolved()` — ASYNC, resolves the hostname and rejects
 *      if ANY resolved IP is private/loopback/link-local/metadata. Run right
 *      before every outbound `fetch` (delivery + test). This closes the
 *      "evil.com passes literal check, then points at 127.0.0.1" hole and
 *      DNS-rebinding where the malicious record is published after creation.
 *
 * Residual TOCTOU: a sub-second rebinding between our resolve and undici's
 * own connect-time lookup is not fully pinned (Node's global `fetch` does not
 * accept a custom dns.lookup without an external dispatcher dep). It is a
 * narrow window; combined with `redirect: 'manual'` on the worker fetch it
 * removes the practical exploit paths (post-validation repoint + 3xx hop).
 */
@Injectable()
export class SsrfGuard {
  private readonly resolver: DnsAllResolver;

  /**
   * `resolver` is injectable-free: NestJS DI can't resolve a type alias, so we
   * mark it @Optional() — Nest passes `undefined` at bootstrap and we fall back
   * to the real DNS lookup. Unit tests pass a stub resolver explicitly.
   */
  constructor(@Optional() resolver?: DnsAllResolver) {
    this.resolver = resolver ?? defaultResolver;
  }

  /** Returns true if the literal hostname appears to be a private/loopback address. */
  static isPrivateHostname(hostname: string): boolean {
    const lower = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

    // Plain names that resolve to local services
    if (lower === 'localhost') return true;
    if (lower === 'localhost.localdomain') return true;

    // IP literals (v4 or v6) reuse the canonical IP classifier.
    if (isIP(lower) !== 0) return SsrfGuard.isPrivateIp(lower);

    return false;
  }

  /**
   * Canonical private/loopback/link-local/metadata classifier for a literal
   * IP address (v4 or v6). Shared by the literal-hostname check and the
   * resolved-IP check so both layers agree on what "private" means.
   */
  static isPrivateIp(ip: string): boolean {
    const family = isIP(ip);
    if (family === 4) return SsrfGuard.isPrivateIpv4(ip);
    if (family === 6) return SsrfGuard.isPrivateIpv6(ip);
    return false; // not an IP literal → caller decides
  }

  private static isPrivateIpv4(ip: string): boolean {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // RFC1918 10/8
    if (a === 169 && b === 254) return true; // link-local 169.254/16 (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 192 && b === 168) return true; // RFC1918 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }

  private static isPrivateIpv6(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return true; // fe80::/10 link-local
    }
    // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4 address.
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return SsrfGuard.isPrivateIpv4(mapped[1]);
    return false;
  }

  /** Returns true if the hostname targets the engine itself (anti-loop guard). */
  static isEngineSelfHostname(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return /^analytics-engine([.-][a-z0-9-]+)*\.veridian\.site$/.test(lower);
  }

  /**
   * Assert that the URL is safe to call from an outbound fetch — SYNC, literal
   * hostname only (no DNS). Use at CRUD time. For the pre-fetch guard that
   * resolves DNS, use {@link assertSafeUrlResolved}.
   *
   * @param url - The destination URL
   * @param opts.allowHttp - Allow non-HTTPS schemes (staging/dev only). Defaults to false.
   * @param opts.allowPrivate - Permit RFC1918/loopback addresses (TEST ONLY). Defaults to false.
   * @throws ForbiddenException with code FORBIDDEN_TARGET / INVALID_URL on rejection.
   */
  assertSafeUrl(
    url: string,
    opts: { allowHttp?: boolean; allowPrivate?: boolean } = {},
  ): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ForbiddenException({
        code: 'INVALID_URL',
        message: 'Malformed URL',
      });
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new ForbiddenException({
        code: 'INVALID_URL',
        message: `Scheme ${protocol} is not allowed`,
      });
    }

    if (protocol === 'http:' && !opts.allowHttp) {
      throw new ForbiddenException({
        code: 'INVALID_URL',
        message:
          'http:// is not allowed in production. Use https:// or enable http on staging/dev.',
      });
    }

    const hostname = parsed.hostname;
    if (!hostname) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_TARGET',
        message: 'URL must include a hostname',
      });
    }

    if (!opts.allowPrivate && SsrfGuard.isPrivateHostname(hostname)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_TARGET',
        message: `Hostname ${hostname} is a private / loopback address`,
      });
    }

    if (SsrfGuard.isEngineSelfHostname(hostname)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_TARGET',
        message: `Hostname ${hostname} targets the engine itself (loop guard)`,
      });
    }

    return parsed;
  }

  /**
   * Pre-fetch SSRF guard: run the literal check, then RESOLVE the hostname and
   * reject if ANY resolved IP is private/loopback/link-local/metadata.
   *
   * This is the guard every outbound `fetch` MUST go through (webhook delivery,
   * webhooks.test, Twenty connector). It blocks:
   *  - a name that passes the literal check but resolves to 127.0.0.1 / 169.254.x
   *  - DNS rebinding where the private record is published after webhook creation
   *
   * A literal IP host is validated by the sync layer already; we still resolve
   * (lookup short-circuits on a literal) so the same code path covers both.
   *
   * @throws ForbiddenException FORBIDDEN_TARGET / INVALID_URL on rejection,
   *         or DNS_RESOLUTION_FAILED if the hostname cannot be resolved.
   */
  async assertSafeUrlResolved(
    url: string,
    opts: { allowHttp?: boolean; allowPrivate?: boolean } = {},
  ): Promise<void> {
    const parsed = this.assertSafeUrl(url, opts);

    // TEST/staging escape hatch: when private targets are explicitly allowed we
    // skip resolution entirely (the literal check already let it through).
    if (opts.allowPrivate) return;

    const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');

    // A literal IP was already vetted by the sync layer above — no DNS needed.
    if (isIP(hostname) !== 0) return;

    let addresses: Array<{ address: string }>;
    try {
      addresses = await this.resolver(hostname);
    } catch (err) {
      throw new ForbiddenException({
        code: 'DNS_RESOLUTION_FAILED',
        message: `Could not resolve ${hostname}: ${(err as Error).message}`,
      });
    }

    if (!addresses || addresses.length === 0) {
      throw new ForbiddenException({
        code: 'DNS_RESOLUTION_FAILED',
        message: `Hostname ${hostname} resolved to no addresses`,
      });
    }

    for (const { address } of addresses) {
      if (SsrfGuard.isPrivateIp(address)) {
        throw new ForbiddenException({
          code: 'FORBIDDEN_TARGET',
          message: `Hostname ${hostname} resolves to a private / loopback address (${address})`,
        });
      }
    }
  }
}
