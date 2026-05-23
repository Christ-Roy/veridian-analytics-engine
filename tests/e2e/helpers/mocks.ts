/**
 * Mocks pour services tiers (Google OAuth, OVH, Telnyx, Web Push, Stripe).
 *
 * Pattern : on intercepte les appels sortants côté bridge via Playwright
 * `page.route()` quand on est en flow UI, ou côté `fetch` direct quand
 * on appelle l'API bridge. Les tests des intégrations VoIP/GSC/Push
 * NE déclenchent JAMAIS de vrais appels externes.
 *
 * Important : ces mocks sont des helpers Playwright. Ils ne tournent QUE
 * dans le contexte Page. Pour mocker côté serveur, il faut un secret
 * spécial `E2E_MOCK_MODE=true` lu par le bridge — pas couvert ici.
 */

import type { Page, Route } from "@playwright/test";

// ─── Google OAuth mock ────────────────────────────────────────────────

/**
 * Intercepte les redirects vers https://accounts.google.com/o/oauth2/*
 * et simule un callback réussi.
 */
export async function mockGoogleOauth(
  page: Page,
  opts: {
    redirectBackTo: string;
    state: string;
    code?: string;
  },
): Promise<void> {
  await page.route(
    /https:\/\/accounts\.google\.com\/o\/oauth2\/.*/,
    async (route: Route) => {
      const url = new URL(route.request().url());
      const stateFromQuery = url.searchParams.get("state") ?? opts.state;
      const code = opts.code ?? "e2e-fake-google-code";
      await route.fulfill({
        status: 302,
        headers: {
          Location: `${opts.redirectBackTo}?code=${code}&state=${stateFromQuery}`,
        },
      });
    },
  );
}

/**
 * Mock du token exchange Google (server-side normally, but exposed for
 * Playwright if needed).
 */
export async function mockGoogleTokenExchange(
  page: Page,
  opts: { tokens?: { access_token: string; refresh_token: string } } = {},
): Promise<void> {
  await page.route(
    /https:\/\/oauth2\.googleapis\.com\/token/,
    async (route: Route) => {
      const tokens = opts.tokens ?? {
        access_token: "e2e-fake-google-access-token",
        refresh_token: "e2e-fake-google-refresh-token",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...tokens,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/webmasters.readonly",
        }),
      });
    },
  );
}

// ─── OVH Telephony mock ───────────────────────────────────────────────

export async function mockOvhTelephony(page: Page): Promise<void> {
  await page.route(
    /https:\/\/(api|eu\.api)\.ovh\.com\/.*/,
    async (route: Route) => {
      const url = route.request().url();
      // /1.0/telephony/{billingAccount}/voiceConsumption
      if (/voiceConsumption/.test(url)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: 12345,
              calledNumber: "+33123456789",
              callerNumber: "+33987654321",
              creationDatetime: new Date().toISOString(),
              duration: 42,
              priceWithoutTax: { value: 0.02, text: "0.02 €", currencyCode: "EUR" },
              wayType: "incoming",
            },
          ]),
        });
        return;
      }
      // default: 200 [] empty
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    },
  );
}

// ─── Telnyx mock ──────────────────────────────────────────────────────

export async function mockTelnyx(page: Page): Promise<void> {
  await page.route(/https:\/\/api\.telnyx\.com\/.*/, async (route: Route) => {
    const url = route.request().url();
    if (/calls/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              record_type: "call",
              from: "+33987654321",
              to: "+33123456789",
              start_time: new Date().toISOString(),
              answer_time: new Date().toISOString(),
              end_time: new Date(Date.now() + 42_000).toISOString(),
              status: "completed",
              call_control_id: "e2e-telnyx-call-id",
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
}

// ─── Web Push mock ────────────────────────────────────────────────────

export async function mockWebPush(page: Page): Promise<void> {
  await page.route(
    /https:\/\/(fcm|updates)\.googleapis\.com\/.*/,
    async (route: Route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    },
  );
}

// ─── Stripe mock ──────────────────────────────────────────────────────

export async function mockStripe(page: Page): Promise<void> {
  await page.route(/https:\/\/api\.stripe\.com\/.*/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "e2e-fake-stripe-id", object: "mock" }),
    });
  });
}
