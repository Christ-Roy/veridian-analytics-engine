/**
 * Lightweight browser fingerprint (B2B identification).
 *
 * Combines a handful of STABLE, low-entropy browser signals into a short,
 * deterministic token. Its job is NOT to uniquely identify a person (that's the
 * persisted visitor_id) — it's to help DISTINGUISH several people sitting behind
 * the SAME company/NAT IP (the classic B2B case: 20 employees, one public IP).
 * The pair (ip, fingerprint) is the discriminator on the server side.
 *
 * Deliberately simple and dependency-free (no fingerprintjs, no canvas/webgl
 * probing): we want a cheap, privacy-restrained signal, not a tracking arms
 * race. Signals chosen are the ones that stay constant for a given
 * device+browser across sessions: UA, language, screen geometry, timezone,
 * platform, color depth, hardware concurrency.
 */

/**
 * Stable djb2 string hash → base36. Deterministic across loads, so the same
 * device produces the same fingerprint on every visit (required for the
 * (ip, fingerprint) discriminator to be meaningful over time).
 */
function hashToBase36(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + charCode, kept in 32-bit range via `| 0`.
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // Unsigned 32-bit → base36 keeps it short (≤7 chars).
  return (hash >>> 0).toString(36);
}

/**
 * Compute the browser fingerprint. Best-effort and fail-safe: any missing API
 * degrades to an empty slot rather than throwing, so a stripped-down browser
 * still yields a stable (if lower-entropy) token. Returns '' only if there is
 * no global at all (non-browser context) — the server treats '' as "unknown".
 */
export function computeFingerprint(): string {
  try {
    const nav: Navigator | undefined =
      typeof navigator !== 'undefined' ? navigator : undefined;
    const scr: Screen | undefined =
      typeof screen !== 'undefined' ? screen : undefined;

    let timezone = '';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      timezone = '';
    }

    const navWithPlatform = nav as
      | (Navigator & {
          platform?: string;
          hardwareConcurrency?: number;
          deviceMemory?: number;
        })
      | undefined;

    const parts: string[] = [
      nav?.userAgent ?? '',
      nav?.language ?? '',
      Array.isArray(nav?.languages) ? nav!.languages.join(',') : '',
      navWithPlatform?.platform ?? '',
      scr ? `${scr.width}x${scr.height}` : '',
      scr ? String(scr.colorDepth ?? '') : '',
      typeof navWithPlatform?.hardwareConcurrency === 'number'
        ? String(navWithPlatform.hardwareConcurrency)
        : '',
      typeof navWithPlatform?.deviceMemory === 'number'
        ? String(navWithPlatform.deviceMemory)
        : '',
      timezone,
    ];

    // If literally nothing is available, return '' (server = "unknown").
    if (parts.every((p) => p === '')) return '';

    return hashToBase36(parts.join('|'));
  } catch {
    return '';
  }
}
