import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  findTrackerScript,
  configFromScript,
  resolveAutoInitConfig,
} from './auto-init';

const TRACKER_SRC =
  'https://analytics-engine.app.veridian.site/sdk/v1/tracker.js';

/** Insert a <script> with the given attributes and return the element. */
function injectScript(attrs: Record<string, string>): HTMLScriptElement {
  const el = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  document.head.appendChild(el);
  return el;
}

describe('auto-init — DOM-driven config from data-* attributes', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    delete window.StaminadsConfig;
  });

  afterEach(() => {
    document.head.innerHTML = '';
    delete window.StaminadsConfig;
  });

  describe('findTrackerScript — <script async> currentScript=null trap', () => {
    it('locates the tag by its /sdk/v1/tracker.js src when currentScript is null', () => {
      // jsdom leaves document.currentScript null for injected scripts — this is
      // exactly the `<script async>` production case the old auto-init missed.
      injectScript({ src: 'https://cdn.example/other.js' });
      const tracker = injectScript({
        src: TRACKER_SRC,
        async: '',
        'data-workspace-id': 'ws_abc',
      });

      expect(document.currentScript).toBeNull();
      const found = findTrackerScript(document);
      expect(found).toBe(tracker);
    });

    it('falls back to data-workspace-id when no /sdk/v1/tracker.js src is present', () => {
      const tracker = injectScript({
        src: 'https://cdn.example/custom-hosted-bundle.js',
        'data-workspace-id': 'ws_custom',
      });

      const found = findTrackerScript(document);
      expect(found).toBe(tracker);
    });

    it('picks the last matching tag (document-order "current script" intuition)', () => {
      injectScript({ src: TRACKER_SRC, 'data-workspace-id': 'ws_first' });
      const last = injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_last',
      });

      const found = findTrackerScript(document);
      expect(found).toBe(last);
    });

    it('matches the src even with a cache-busting query string', () => {
      const tracker = injectScript({
        src: `${TRACKER_SRC}?v=2`,
        'data-workspace-id': 'ws_q',
      });
      expect(findTrackerScript(document)).toBe(tracker);
    });

    it('returns null when no tracker tag is present', () => {
      injectScript({ src: 'https://cdn.example/unrelated.js' });
      expect(findTrackerScript(document)).toBeNull();
    });
  });

  describe('configFromScript', () => {
    it('maps data-workspace-id → workspace_id and defaults endpoint to the script origin', () => {
      const tracker = injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_abc',
      });

      const config = configFromScript(tracker);
      expect(config).not.toBeNull();
      expect(config!.workspace_id).toBe('ws_abc');
      // No data-endpoint → default to the origin serving the bundle.
      expect(config!.endpoint).toBe(
        'https://analytics-engine.app.veridian.site',
      );
    });

    it('honours an explicit data-endpoint over the script origin', () => {
      const tracker = injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_abc',
        'data-endpoint': 'https://custom.ingest.example',
      });

      const config = configFromScript(tracker);
      expect(config!.endpoint).toBe('https://custom.ingest.example');
    });

    it('parses data-cross-domains into a trimmed array (cross-domain tunnels)', () => {
      const tracker = injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_yoga',
        'data-cross-domains': 'app.yoga-sculpt.fr, www.yoga-sculpt.fr',
      });

      const config = configFromScript(tracker);
      expect(config!.crossDomains).toEqual([
        'app.yoga-sculpt.fr',
        'www.yoga-sculpt.fr',
      ]);
    });

    it('parses data-ad-click-ids and boolean feature flags', () => {
      const tracker = injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_abc',
        'data-ad-click-ids': 'gclid,fbclid',
        'data-debug': 'true',
        'data-track-clicks': 'false',
      });

      const config = configFromScript(tracker);
      expect(config!.adClickIds).toEqual(['gclid', 'fbclid']);
      expect(config!.debug).toBe(true);
      expect(config!.trackClicks).toBe(false);
    });

    it('returns null when data-workspace-id is missing (never inits a useless tag)', () => {
      const tracker = injectScript({ src: TRACKER_SRC });
      expect(configFromScript(tracker)).toBeNull();
    });

    it('omits optional fields when their data-* attributes are absent', () => {
      const tracker = injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_abc',
      });
      const config = configFromScript(tracker);
      expect(config!.crossDomains).toBeUndefined();
      expect(config!.adClickIds).toBeUndefined();
      expect(config!.debug).toBeUndefined();
    });
  });

  describe('resolveAutoInitConfig — precedence', () => {
    it('builds config from the snippet data-* when no global config', () => {
      injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_dom',
      });

      const config = resolveAutoInitConfig(window, document);
      expect(config).not.toBeNull();
      expect(config!.workspace_id).toBe('ws_dom');
    });

    it('window.StaminadsConfig wins over data-* (backward compat)', () => {
      window.StaminadsConfig = {
        workspace_id: 'ws_global',
        endpoint: 'https://global.example',
      };
      injectScript({
        src: TRACKER_SRC,
        'data-workspace-id': 'ws_dom',
      });

      const config = resolveAutoInitConfig(window, document);
      expect(config!.workspace_id).toBe('ws_global');
      expect(config!.endpoint).toBe('https://global.example');
    });

    it('returns null when neither source is usable (no init, no throw)', () => {
      injectScript({ src: 'https://cdn.example/unrelated.js' });
      expect(resolveAutoInitConfig(window, document)).toBeNull();
    });
  });
});
