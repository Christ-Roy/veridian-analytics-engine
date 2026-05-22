/**
 * Helper Playwright qui boot un bridge local (+ faux staminads optionnel) sur
 * ports éphémères.
 *
 * Deux modes :
 *  1. `bootBridgeForTest()` — bridge isolé via `createHubBridge` (helper hub
 *     partagé). Le hook `createStaminadsWorkspace` est mocké → les routes
 *     `/api/tenants/*` (HMAC) marchent sans réseau. Mais les routes admin
 *     `/api/admin/tenant/:id/status|score` appellent staminads pour de vrai →
 *     elles renvoient 500 dans ce mode (staminads injoignable).
 *  2. `bootBridgeWithStaminads()` — bridge câblé sur un `FakeStaminads` HTTP
 *     réel. Les routes admin `/status` (analytics.query) marchent. Le test
 *     peut piloter le comportement staminads via `fixture.staminads.setBehavior`.
 *
 * Pas de dépendance à un serveur distant — les tests promise-flows tournent en
 * isolation totale, déterministes et rapides.
 */

import { createApp } from "../../../src/app.js";
import type { PageviewsFetcher } from "../../../src/tenant-status.js";
import { InMemoryTenantStore } from "../../../src/hub/store.js";
import {
  createHubBridge,
  signedFetch,
  TEST_SECRET,
  ADMIN_KEY,
  type HubBridgeFixture,
} from "../../hub/helpers.js";
import {
  FakeStaminads,
  startAppOnEphemeralPort,
} from "../../helpers/fake-staminads.js";

export interface BridgeFixture extends HubBridgeFixture {
  /** Secret HMAC partagé. */
  secret: string;
  /** Admin API key (Bearer). */
  adminKey: string;
  /**
   * Faux staminads HTTP (présent uniquement si booté via
   * `bootBridgeWithStaminads`). Permet `setBehavior` / `getCalls`.
   */
  staminads?: FakeStaminads;
  /** Helper Bearer fetch — pour les endpoints /api/admin/*. */
  adminFetch(method: string, path: string, body?: unknown): Promise<Response>;
  /** Helper HMAC fetch — pour les endpoints /api/tenants/* (signés Hub). */
  signedFetch(
    method: string,
    path: string,
    body?: unknown,
    opts?: Parameters<typeof signedFetch>[4]
  ): Promise<Response>;
}

function wrapFixture(
  base: HubBridgeFixture,
  extra: { staminads?: FakeStaminads } = {}
): BridgeFixture {
  return {
    ...base,
    secret: TEST_SECRET,
    adminKey: ADMIN_KEY,
    staminads: extra.staminads,
    adminFetch: (method, path, body) =>
      fetch(`${base.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    signedFetch: (method, path, body, signOpts) =>
      signedFetch(base.url, method, path, body, signOpts),
  };
}

/**
 * Crée un bridge isolé pour 1 test E2E (mode mock pur, pas de staminads HTTP).
 *
 * @param opts options du createHubBridge (staminadsImpl custom, loadStats, store)
 */
export async function bootBridgeForTest(
  opts: Parameters<typeof createHubBridge>[0] = {}
): Promise<BridgeFixture> {
  const fixture = await createHubBridge(opts);
  return wrapFixture(fixture);
}

export interface BootWithStaminadsOpts {
  /**
   * Override du fetcher pageviews 30j pour la route `/status`. Si absent, la
   * route interroge le FakeStaminads via analytics.query (qui renvoie le
   * `analyticsBody` par défaut — donc des pageviews non nuls).
   */
  pageviewsFetcher?: PageviewsFetcher;
}

/**
 * Crée un bridge câblé sur un `FakeStaminads` HTTP réel.
 *
 * À utiliser pour les flows qui exercent les routes admin staminads-backed
 * (`/api/admin/tenant/:id/status`, `/score`, `/analytics`). Le `provision`
 * Hub est tout de même mocké (hook `createStaminadsWorkspace`) pour rester
 * déterministe sur les workspaceId.
 *
 * Le test peut piloter staminads via `fixture.staminads!.setBehavior({...})`.
 */
export async function bootBridgeWithStaminads(
  opts: BootWithStaminadsOpts = {}
): Promise<BridgeFixture> {
  const staminads = new FakeStaminads();
  const staminadsUrl = await staminads.start();

  const store = new InMemoryTenantStore();
  const staminadsCalls: HubBridgeFixture["staminadsCalls"] = [];
  let counter = 0;

  const app = createApp(
    {
      staminadsUrl,
      adminEmail: "admin@veridian.local",
      adminPassword: "test-pass-2026",
      veridianAdminApiKey: ADMIN_KEY,
      hub: {
        hmacSecret: TEST_SECRET,
        store,
        // Hook provision mocké : ids stables, pas de dépendance au réseau
        // pour la partie Hub (le FakeStaminads ne sert qu'aux routes admin).
        createStaminadsWorkspace: async (input) => {
          staminadsCalls.push({ ...input });
          counter += 1;
          return {
            workspaceId: `ws_fake_${counter}`,
            apiKey: `sk_fake_${counter}_${input.hubTenantId.slice(0, 8)}`,
          };
        },
      },
    },
    { pageviewsFetcher: opts.pageviewsFetcher }
  );

  const started = await startAppOnEphemeralPort(app);

  const base: HubBridgeFixture = {
    url: started.url,
    store,
    staminadsCalls,
    resetStaminadsCalls: () => {
      staminadsCalls.length = 0;
    },
    close: async () => {
      await started.close();
      await staminads.stop();
    },
  };

  return wrapFixture(base, { staminads });
}

/** Helper : ID stable d'un Hub tenant pour tests. */
export function fakeHubTenantId(slug: string): string {
  return `hub_tnt_${slug}_${Date.now().toString(36)}`;
}
