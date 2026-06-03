import { ForbiddenException, Injectable } from '@nestjs/common';

/**
 * SSRF allowlist — cf PATTERNS-WEBHOOKS.md §9.
 *
 * Refuses (raises ForbiddenException with code FORBIDDEN_TARGET):
 * - localhost / loopback / `0.0.0.0`
 * - RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 * - Link-local 169.254/16 (cloud metadata!)
 * - IPv6 loopback / unique-local / link-local
 * - non-HTTPS scheme when WEBHOOK_ALLOW_HTTP != "true"
 * - URLs targeting the engine itself (anti-loop guard)
 *
 * V1 limitation (cf PATTERNS-WEBHOOKS.md §9): we check the hostname
 * literal at create/update/delivery time, NOT the resolved IP. DNS
 * rebinding (`evil.com → 127.0.0.1`) is therefore not blocked here.
 * Phase 2 will add DNS resolution + force-IP via custom http.Agent.
 */
@Injectable()
export class WebhookSsrfGuard {
  /** Returns true if the literal hostname appears to be a private/loopback address. */
  static isPrivateHostname(hostname: string): boolean {
    const lower = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

    // Plain names that resolve to local services
    if (lower === 'localhost') return true;
    if (lower === 'localhost.localdomain') return true;

    // IPv4 literals
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower)) {
      const parts = lower.split('.').map((n) => parseInt(n, 10));
      // 0.0.0.0 / 127.0.0.0/8 / 10.0.0.0/8 / 169.254.0.0/16 / 172.16.0.0/12 / 192.168.0.0/16
      if (parts[0] === 0) return true;
      if (parts[0] === 127) return true;
      if (parts[0] === 10) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      return false;
    }

    // IPv6 literals (best-effort — exact match on a few common ones)
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }

    return false;
  }

  /** Returns true if the hostname targets the engine itself (anti-loop guard). */
  static isEngineSelfHostname(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return /^analytics-engine([.-][a-z0-9-]+)*\.veridian\.site$/.test(lower);
  }

  /**
   * Assert that the URL is safe to call from the webhook worker.
   * @param url - The destination URL
   * @param opts.allowHttp - Allow non-HTTPS schemes (staging/dev only). Defaults to false.
   * @param opts.allowPrivate - Permit RFC1918/loopback addresses (TEST ONLY). Defaults to false.
   * @throws ForbiddenException with code FORBIDDEN_TARGET on rejection.
   */
  assertSafeUrl(
    url: string,
    opts: { allowHttp?: boolean; allowPrivate?: boolean } = {},
  ): void {
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
          'http:// is not allowed in production. Use https:// or set WEBHOOK_ALLOW_HTTP=true on staging/dev.',
      });
    }

    const hostname = parsed.hostname;
    if (!hostname) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_TARGET',
        message: 'URL must include a hostname',
      });
    }

    if (!opts.allowPrivate && WebhookSsrfGuard.isPrivateHostname(hostname)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_TARGET',
        message: `Hostname ${hostname} is a private / loopback address`,
      });
    }

    if (WebhookSsrfGuard.isEngineSelfHostname(hostname)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_TARGET',
        message: `Hostname ${hostname} targets the engine itself (loop guard)`,
      });
    }
  }
}
