import { describe, it, expect } from 'vitest';
import { buildTrackerSnippet, TRACKER_SDK_PATH } from '../snippet';

/**
 * P0 — Snippet SDK généré par l'UI ↔ contrat backend.
 *
 * Bug d'origine (audit configui 2026-06-17) : les 3 emplacements de la console
 * généraient un `<script src>` vers `/sdk/staminads_<version>.min.js` ou
 * `/sdk/staminads.min.js` — TOUS 404. Le backend (SdkController,
 * `@Controller('sdk/v1')`) ne sert le bundle QUE sous `/sdk/v1/tracker.js`.
 * Résultat : chaque nouveau client installait un tracker mort.
 *
 * Ce test verrouille la SOURCE UNIQUE du snippet sur le bon chemin backend.
 */

const ENDPOINT = 'https://analytics-engine.app.veridian.site';

describe('buildTrackerSnippet — contrat URL backend', () => {
  it('exposes the frozen backend SDK path', () => {
    expect(TRACKER_SDK_PATH).toBe('/sdk/v1/tracker.js');
  });

  it('points the <script src> at /sdk/v1/tracker.js (the only path served)', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'acme',
      endpoint: ENDPOINT,
    });
    expect(snippet).toContain(
      `<script async src="${ENDPOINT}/sdk/v1/tracker.js"></script>`,
    );
  });

  it('never regenerates the old 404 URLs', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'acme',
      endpoint: ENDPOINT,
    });
    expect(snippet).not.toContain('staminads.min.js');
    expect(snippet).not.toMatch(/staminads_[\d.]+\.min\.js/);
    expect(snippet).not.toContain('/sdk/staminads');
  });

  it('embeds the workspaceId, endpoint and SPA/scroll tracking config', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'acme_boulangerie',
      endpoint: ENDPOINT,
    });
    expect(snippet).toContain('"acme_boulangerie"');
    expect(snippet).toContain(`"${ENDPOINT}"`);
    expect(snippet).toContain('window.StaminadsConfig');
    expect(snippet).toContain('trackSPA: true');
    expect(snippet).toContain('trackScroll: true');
  });

  it('strips a trailing slash from the endpoint', () => {
    const snippet = buildTrackerSnippet({
      workspaceId: 'ws1',
      endpoint: 'https://example.com/',
    });
    expect(snippet).not.toContain('example.com//');
    expect(snippet).toContain('https://example.com/sdk/v1/tracker.js');
  });
});
