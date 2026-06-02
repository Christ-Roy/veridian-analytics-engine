# Veridian Analytics Tracker (Web SDK)

> **Forked from `@staminads/sdk` v6.1.0** — same engine, distributed as
> `@veridian/analytics-tracker` and served by Veridian's analytics engine.
> Documentation below is the Veridian integrator quickstart. Upstream
> staminads docs follow further down.

Ultra-reliable web analytics tracker for the Veridian platform. Captures
pageviews, UTM, focus-time, scroll engagement, and custom goals — sends
them to your tenant's Veridian Analytics engine.

---

## Quickstart — `<script>` tag (recommended)

Drop these two lines just before `</head>` on any page you want tracked:

```html
<script>
  window.StaminadsConfig = {
    workspace_id: 'vrd_xxxxx',              // your Veridian workspace id
    endpoint: 'https://analytics-engine.app.veridian.site',
  };
</script>
<script src="https://analytics-engine.app.veridian.site/sdk/v1/tracker.js" defer></script>
```

That's it. The tracker auto-initializes, captures the first pageview, UTM
parameters from `window.location.search`, and starts measuring engagement.

**Staging endpoint** (for testing before going live):

```
https://analytics-engine.staging.veridian.site/sdk/v1/tracker.js
```

### Why two `<script>` tags?

The config block (`window.StaminadsConfig = {...}`) MUST be inline and
evaluate BEFORE the SDK loads. The SDK reads `window.StaminadsConfig` at
import time to auto-initialize without a second `init()` call. Both tags
can use `defer` if you load them in the head, or omit it if you place
them at the end of `<body>`.

---

## Quickstart — npm (Next.js, Vite, advanced setups)

```bash
pnpm add @veridian/analytics-tracker
```

```ts
// _app.tsx or a top-level layout
import { useEffect } from 'react';

useEffect(() => {
  window.StaminadsConfig = {
    workspace_id: 'vrd_xxxxx',
    endpoint: 'https://analytics-engine.app.veridian.site',
  };
  // Dynamic import so the tracker isn't bundled into the SSR build
  import('@veridian/analytics-tracker');
}, []);
```

> **Status (2026-06-02)** : the npm package is not yet published on the
> public registry. For Next.js apps inside the Veridian org, the
> `<script>` snippet above is the recommended path until the package
> goes live. The bundle served at `/sdk/v1/tracker.js` is identical to
> the npm one.

---

## API — minimum surface for the sales funnel

| Need | Call |
|---|---|
| Pageview (automatic on load + SPA nav) | nothing — auto |
| SPA navigation in code | `await Staminads.trackPageView('/new-path')` |
| Identify a visitor (signup, form submit) | `await Staminads.setUserId('user@example.com')` |
| Custom event (form submission, CTA click, RDV booked) | `await Staminads.trackGoal({ action: 'form_submission', properties: { form: 'contact' } })` |
| UTM parameters | captured automatically from `window.location.search` |
| `visitor_id` (anonymous cookie) | posed automatically, 13-month 1st-party cookie |
| Pause / resume tracking | `await Staminads.pause()` / `await Staminads.resume()` |
| Debug what's being sent | `Staminads.debug()` returns the live session state |

All methods are async — they return `Promise` so you can `await` them
before navigating away on form submit:

```js
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await Staminads.trackGoal({
    action: 'form_submission',
    properties: { form: 'contact-home' },
  });
  form.submit();
});
```

---

## GDPR / ePrivacy — consent gating

`visitor_id` is a tracking cookie, not a strictly-necessary one. You
MUST get explicit consent under "Analytics" before loading the tracker.

Recommended pattern with a consent banner:

```js
// Don't include the <script src="...tracker.js"> tag in the initial HTML.
// Load it only after the user grants Analytics consent.
window.addEventListener('consent-changed', (e) => {
  if (e.detail.categories?.analytics === 'granted' && !window.__vrd_loaded) {
    window.__vrd_loaded = true;
    const s = document.createElement('script');
    s.src = 'https://analytics-engine.app.veridian.site/sdk/v1/tracker.js';
    s.defer = true;
    document.head.appendChild(s);
  }
});
```

Until consent is granted, **nothing** is stored client-side and **no
network call** is made to the engine.

---

## CSP — Content Security Policy

If your site uses a strict CSP, allow the engine origin:

```
script-src 'self' https://analytics-engine.app.veridian.site;
connect-src 'self' https://analytics-engine.app.veridian.site;
```

The tracker does NOT use `eval`, `new Function`, or inline scripts — it
is compatible with CSP Level 2/3 without `unsafe-inline`/`unsafe-eval`.

### Subresource Integrity (SRI)

The bundle URL is versioned (`/sdk/v1/`) and served with
`Cache-Control: public, max-age=3600, immutable`. The build artifact for
a given v1 release is content-addressable. To pin a specific build, host
the bundle yourself or query `/sdk/v1/manifest.json` for the current
size and re-derive an SRI hash:

```bash
curl -s https://analytics-engine.app.veridian.site/sdk/v1/tracker.js \
  | openssl dgst -sha384 -binary \
  | openssl base64 -A
```

```html
<script
  src="https://analytics-engine.app.veridian.site/sdk/v1/tracker.js"
  integrity="sha384-<hash from above>"
  crossorigin="anonymous"
  defer
></script>
```

---

## Verifying the integration

After deploying the snippet, three checks confirm end-to-end works:

1. **The bundle loads**

   ```bash
   curl -I https://analytics-engine.app.veridian.site/sdk/v1/tracker.js
   # → HTTP/2 200, content-type: application/javascript, ~20 KB gzipped
   ```

2. **Live events arrive** — open your workspace in the Veridian console
   (`/workspaces/<wsId>/live`) and refresh your site in another tab.
   The pageview appears within ~2 seconds.

3. **Manifest endpoint** — sanity check:

   ```bash
   curl -s https://analytics-engine.app.veridian.site/sdk/v1/manifest.json
   ```

   Returns `{ sdk, version, bundles, umd_size_bytes, cache_max_age_seconds }`.

---

## Bundle size & assets served

| Asset | URL | Format | Size |
|---|---|---|---|
| UMD (browser `<script>`) | `/sdk/v1/tracker.js` | UMD, minified | ~20 KB gzip |
| ESM (bundlers) | `/sdk/v1/tracker.esm.js` | ESM | ~20 KB gzip |
| TypeScript declarations | `/sdk/v1/tracker.d.ts` | `.d.ts` | <5 KB |
| Manifest | `/sdk/v1/manifest.json` | JSON | <500 B |

The public URLs are **versioned and frozen**. Breaking changes ship on
`/sdk/v2/` — `/sdk/v1/` keeps working forever (or until officially
sunset with 6 months notice in the Veridian changelog).

---

## What is captured

| Field | Source |
|---|---|
| `path`, `referrer`, `title` | `window.location`, `document` |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id` | `window.location.search` (auto) |
| Ad click IDs (`gclid`, `fbclid`, `msclkid`, `dclid`, `twclid`, `ttclid`, `li_fat_id`, `wbraid`, `gbraid`) | `window.location.search` (auto) |
| `user_agent`, `device`, `browser`, `os` | UA + Client Hints |
| `viewport_width`, `viewport_height`, `screen_width`, `screen_height` | `window.innerWidth`, `screen` |
| `language`, `timezone` | `navigator`, `Intl.DateTimeFormat` |
| Focus duration (ms), scroll depth (%) | live measurement |

No PII is captured by default. `setUserId(email)` is the only call that
attaches identity — and it MUST be called only after user consent.

---

## Troubleshooting

**The bundle returns 404**
The engine deployment is missing the `sdk-builder` Docker stage outputs.
Check `Dockerfile` → search for `COPY --from=sdk-builder`. The build
artifact must end up in `dist/public/sdk/v1/staminads.min.js`.

**Events never arrive in the console**
1. Check the network tab: `POST /api/track` should return 200.
2. Check the workspace_id matches a real workspace in your tenant DB.
3. Check that the consent banner posted `analytics: granted` BEFORE the
   tracker loaded.
4. Try `Staminads.debug()` in the console — `session_id` should be a
   UUID, `actions_buffered` should grow on each interaction.

**CORS error in the browser**
The engine's `/api/track` endpoint sets `Access-Control-Allow-Origin: *`
unconditionally. If you see a CORS error, you're hitting the wrong
origin — verify the `endpoint` config matches your actual engine URL
(prod vs staging vs self-hosted).

**TypeScript types for `window.StaminadsConfig`**
Add to your project's `globals.d.ts`:

```ts
import type { StaminadsConfig } from '@veridian/analytics-tracker';
declare global {
  interface Window {
    StaminadsConfig?: StaminadsConfig;
  }
}
```

---

## Building from source

```bash
cd sdk
npm ci
npm run build
# → dist/staminads.min.js (UMD, ~20 KB gzip)
# → dist/staminads.esm.js (ESM)
# → dist/staminads.d.ts   (TypeScript declarations)
```

The version string is pulled from `api/src/version.ts` at build time —
single source of truth across the engine.

---

# Upstream staminads docs (reference)

> Everything below is the original `@staminads/sdk` documentation,
> preserved verbatim. Veridian-specific notes are in the section above.

## Mission Critical

- **Zero Data Loss**: Every session MUST be captured and transmitted
- **Exact Duration**: Focus time measured with millisecond precision, counting only truly active engagement

## Features

- **Focus State Machine**: FOCUSED → BLURRED → HIDDEN states with precise transitions
- **Multi-Channel Transmission**: Beacon → Fetch → Offline Queue (never lose data)
- **localStorage + Memory Fallback**: Simple, reliable storage (Safari Private Mode safe)
- **SPA Support**: Auto-detects pushState, replaceState, popstate, hashchange
- **Client Hints**: Accurate OS detection (Win10 vs 11, macOS versions) via ua-parser-js
- **Bot Detection**: User-agent patterns + webdriver + fingerprinting
- **Custom Dimensions**: stm_1...stm_10 for custom tracking
- **Ad Click ID Tracking**: gclid, fbclid, msclkid, and more

## Full API

All methods (except `getConfig()` and `debug()`) are async and return Promises.

```typescript
// Session info (async)
await Staminads.getSessionId();       // Current session UUID
await Staminads.getFocusDuration();   // Active time in milliseconds
await Staminads.getTotalDuration();   // Wall clock time in milliseconds

// Synchronous methods
Staminads.getConfig();                // Returns config or null
Staminads.debug();                    // Get debug info

// Manual tracking (async)
await Staminads.trackPageView(url?);  // Track SPA navigation
await Staminads.trackGoal({ action, value?, currency?, properties? });

// Custom Dimensions (async)
await Staminads.setDimension(1, 'premium');    // Set stm_1 = 'premium'
await Staminads.setDimensions({ 1: 'a', 2: 'b' }); // Set multiple
await Staminads.getDimension(1);               // Get dimension value
await Staminads.clearDimensions();             // Clear all

// Control (async)
await Staminads.pause();              // Pause tracking
await Staminads.resume();             // Resume tracking
await Staminads.reset();              // Clear session, start fresh
```

## Configuration

```typescript
interface StaminadsConfig {
  // Required
  workspace_id: string // Workspace identifier
  endpoint: string // API endpoint (required - no default)

  // Optional
  debug?: boolean // Default: false
  sessionTimeout?: number // Default: 30 * 60 * 1000 (30 min)
  adClickIds?: string[] // Default: ['gclid', 'fbclid', 'msclkid', ...]
  trackSPA?: boolean // Default: true
  trackScroll?: boolean // Default: true
}
```

## Events Tracked

| Event         | Trigger                                 | Data                      |
| ------------- | --------------------------------------- | ------------------------- |
| `screen_view` | Page load, SPA navigation               | path, referrer, UTM       |
| `ping`        | Heartbeat (10s desktop, 7s mobile)      | duration, max_scroll      |
| `scroll`      | Scroll milestones (25%, 50%, 75%, 100%) | max_scroll                |
| `goal`        | trackGoal() call                        | action, value, properties |

## Browser Support

| Browser        | Version |
| -------------- | ------- |
| Chrome         | 60+     |
| Firefox        | 55+     |
| Safari         | 11+     |
| Edge           | 79+     |
| iOS Safari     | 11+     |
| Android Chrome | 60+     |

## Documentation

See [SPECS.md](./SPECS.md) for detailed technical specifications.
