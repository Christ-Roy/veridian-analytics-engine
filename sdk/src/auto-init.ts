/**
 * Auto-init resolver — build a StaminadsConfig from the page DOM.
 *
 * Why this file exists
 * --------------------
 * The official install snippet handed to clients is a single tag:
 *
 *   <script async src="https://…/sdk/v1/tracker.js" data-workspace-id="<ws>"></script>
 *
 * Historically the bundle ONLY auto-initialised from `window.StaminadsConfig`
 * and completely ignored that `data-workspace-id` — so the nominal snippet
 * loaded the bundle but never called `init()`, and tracked nothing. This module
 * makes the snippet self-initialising by reading the script tag's `data-*`
 * attributes, exactly as integrators expect from a `data-*`-configured tag.
 *
 * The `<script async>` currentScript trap
 * ---------------------------------------
 * `document.currentScript` is the gold path to locate the running tag, but it
 * is **null** while an `async`/`defer` external script executes (the spec only
 * populates it for classic, synchronously-executing scripts). Our snippet is
 * `async`, so we MUST fall back to locating the tag another way: scan all
 * `<script src=…/sdk/v1/tracker.js>` (the frozen public path) and, failing
 * that, any `<script data-workspace-id>`. We pick the last match (latest tag in
 * document order wins, mirroring "current script" intuition).
 *
 * Precedence
 * ----------
 * `window.StaminadsConfig` always wins when present (explicit programmatic
 * config / backward compat). DOM data-* attributes only fill the gaps. This
 * keeps every existing integration working unchanged.
 */

import type { StaminadsConfig } from './types';

/** The frozen public path the tracker bundle is served from. */
const TRACKER_SRC_MARKER = '/sdk/v1/tracker.js';

/**
 * Locate the tracker <script> tag in the document.
 *
 * Order of resolution:
 *   1. `document.currentScript` — works for classic (non-async) scripts.
 *   2. last `<script src=…/sdk/v1/tracker.js…>` — the canonical install.
 *   3. last `<script data-workspace-id>` — tolerant fallback (custom hosting,
 *      data-attribute set on a differently-named tag).
 */
export function findTrackerScript(doc: Document): HTMLScriptElement | null {
  const current = doc.currentScript;
  if (current && current instanceof HTMLScriptElement) {
    return current;
  }

  const scripts = Array.from(doc.getElementsByTagName('script'));

  // Match by the frozen public src path first (handles ?v=, #hash, query).
  const bySrc = scripts.filter((s) => {
    const src = s.getAttribute('src') || '';
    return src.indexOf(TRACKER_SRC_MARKER) !== -1;
  });
  if (bySrc.length > 0) {
    return bySrc[bySrc.length - 1];
  }

  // Fallback: any tag carrying the workspace marker attribute.
  const byData = scripts.filter((s) => s.hasAttribute('data-workspace-id'));
  if (byData.length > 0) {
    return byData[byData.length - 1];
  }

  return null;
}

/**
 * Best-effort origin of a script's `src` (the analytics engine that serves the
 * bundle is also the ingestion endpoint, so it's the right default endpoint).
 * Returns '' when the src is missing or unparseable.
 */
function originFromScriptSrc(script: HTMLScriptElement): string {
  const src = script.getAttribute('src') || '';
  if (!src) return '';
  try {
    // Resolve relative srcs against the current document.
    const base =
      typeof window !== 'undefined' && window.location
        ? window.location.href
        : undefined;
    return new URL(src, base).origin;
  } catch {
    return '';
  }
}

/** Parse a comma/space separated list into a trimmed, non-empty string array. */
function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse a `data-*` boolean ("true"/"false", "1"/"0"). undefined when absent. */
function parseBool(raw: string | null | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === '') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

/**
 * Build a StaminadsConfig from a tracker <script> tag's data-* attributes.
 * Returns null when no usable `data-workspace-id` is present (we never init
 * a tag that can't possibly track).
 *
 * Supported attributes (all optional except data-workspace-id):
 *   data-workspace-id   → workspace_id        (REQUIRED)
 *   data-endpoint       → endpoint            (default: origin of the script src)
 *   data-cross-domains  → crossDomains[]      ("a.com,b.com")
 *   data-ad-click-ids   → adClickIds[]        ("gclid,fbclid")
 *   data-debug          → debug               ("true"/"false")
 *   data-track-spa      → trackSPA
 *   data-track-scroll   → trackScroll
 *   data-track-clicks   → trackClicks
 */
export function configFromScript(
  script: HTMLScriptElement,
): StaminadsConfig | null {
  const ds = script.dataset;
  const workspaceId = (ds.workspaceId || '').trim();
  if (!workspaceId) return null;

  const endpoint = (ds.endpoint || '').trim() || originFromScriptSrc(script);

  const config: StaminadsConfig = {
    workspace_id: workspaceId,
    endpoint,
  };

  const crossDomains = parseList(ds.crossDomains);
  if (crossDomains.length > 0) config.crossDomains = crossDomains;

  const adClickIds = parseList(ds.adClickIds);
  if (adClickIds.length > 0) config.adClickIds = adClickIds;

  const debug = parseBool(ds.debug);
  if (debug !== undefined) config.debug = debug;

  const trackSPA = parseBool(ds.trackSpa);
  if (trackSPA !== undefined) config.trackSPA = trackSPA;

  const trackScroll = parseBool(ds.trackScroll);
  if (trackScroll !== undefined) config.trackScroll = trackScroll;

  const trackClicks = parseBool(ds.trackClicks);
  if (trackClicks !== undefined) config.trackClicks = trackClicks;

  return config;
}

/**
 * Resolve the auto-init config for the current page, in precedence order:
 *   1. window.StaminadsConfig (explicit, backward-compatible) — wins outright.
 *   2. data-* attributes on the tracker <script> tag (the nominal snippet).
 * Returns null when neither yields a usable config (nothing to init).
 */
export function resolveAutoInitConfig(
  win: Window,
  doc: Document,
): StaminadsConfig | null {
  if (win.StaminadsConfig) {
    return win.StaminadsConfig;
  }
  const script = findTrackerScript(doc);
  if (!script) return null;
  return configFromScript(script);
}
