/**
 * 00-gate-onpremise — LE rempart E2E on-premise avant promo prod.
 *
 * Robert considère un E2E on-premise FIABLE comme la condition essentielle de
 * passage en prod. Cette spec est ce rempart : elle teste le VRAI scope
 * commercialisé (les 3 features de la vision 2026-05-23) de bout en bout,
 * contre le staging RÉEL (ClickHouse réel, Postgres réel — rien de mocké).
 *
 *   1. Visiteurs uniques / tracking : provision → snippet → ingestion réelle
 *      round-trip ClickHouse (tracking.verify, dry-run + purge) → /api/track
 *      public → analytics.query requêtable.
 *   2. Calls / VoIP : voip.addPhoneNumber + voip.listPhoneNumbers (le numéro
 *      par source qui alimente l'attribution des appels).
 *   3. Search Console : gsc.status (le connecteur GSC répond, état lisible).
 *
 * Tout passe par l'API M2M native `POST /api/admin/platform/*`
 * (PLATFORM_ADMIN_API_KEY) — l'ancien micro-service bridge est décommissionné.
 *
 * SELF-CONTAINED + IDEMPOTENT :
 *   - crée SON PROPRE workspace jetable (préfixe `e2e_gate_` + uuid unique) —
 *     ne touche JAMAIS un workspace client réel ;
 *   - le purge en fin de run (super-admin workspaces.delete, best-effort) ;
 *   - tracking.verify est un dry-run qui s'auto-purge → zéro pollution stats.
 *
 * Pas de secret → skip propre (jamais d'erreur).
 *
 * ─── OÙ TOURNE CE GATE ? ──────────────────────────────────────────────────
 * Le gate CI bloquant s'exécute via le script bash jumeau
 * `gate-scenario.sh`, lancé SUR dev-pub par le workflow
 * `e2e-gate-onpremise.yml`. Raison : `analytics-engine.staging.veridian.site`
 * résout sur une IP Tailnet (staging derrière Tailscale) — un runner GitHub
 * public ne peut PAS l'atteindre. dev-pub est sur le tailnet et atteint
 * l'engine en local. Le script bash couvre exactement le même parcours que
 * cette spec, sans imposer un build Playwright sur dev-pub (no-build-local).
 *
 * Cette spec `.ts` reste le reflet typé/lisible du gate, utilisable À LA MAIN
 * par un dev connecté au tailnet :
 *   cd tests/e2e && PLATFORM_ADMIN_API_KEY=… TARGET=staging npm run test:gate
 * (et redeviendra le gate CI direct le jour où le runner rejoint le tailnet
 *  via l'action tailscale/github-action + secret TS_OAUTH — todo INFRA).
 */

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTarget, type TargetName } from "../helpers/targets";
import {
  PlatformM2MClient,
  deleteWorkspaceAsSuperAdmin,
  type ProvisionResult,
  type TrackingVerifyResult,
  type WorkspaceStatusResult,
} from "../helpers/platform-m2m";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

// Le gate ne tourne que contre un engine multi-tenant (staging/prod), jamais
// contre la démo single-tenant (pas de provision M2M là-bas).
const m2m = PlatformM2MClient.fromEnv(target);

/** Workspace jetable unique à ce run — préfixe identifiable + cleanable. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`.replace(
  /[^a-z0-9]/g,
  "",
);
const WS_ID = `e2e_gate_${RUN}`.slice(0, 50);

test.describe(`E2E gate on-premise — vrai scope commercialisé [${TARGET}] @gate`, () => {
  test.skip(
    target.isDemo,
    "Gate = engine multi-tenant (provision M2M), pas la démo single-tenant.",
  );
  test.skip(
    !m2m,
    "PLATFORM_ADMIN_API_KEY manquant — gate skip (CI sans secret M2M).",
  );

  // Le scénario est séquentiel : provision d'abord, le reste s'appuie dessus.
  test.describe.configure({ mode: "serial" });

  let provisioned: ProvisionResult | null = null;

  test.afterAll(async () => {
    if (provisioned && m2m) {
      const r = await deleteWorkspaceAsSuperAdmin(target, WS_ID);
      // Log informatif — un cleanup raté ne fait pas échouer le gate (le ws
      // jetable reste identifiable par son préfixe e2e_gate_).
      console.log(
        `[gate cleanup] workspace=${WS_ID} deleted=${r.deleted}` +
          (r.reason ? ` reason=${r.reason}` : ""),
      );
    }
  });

  test("1. Provision tenant M2M → workspace + clé stam_live + snippet", async () => {
    if (!m2m) return;
    const { status, data } = await m2m.provisionTenant({
      email: `e2e-gate-${RUN}@veridian-test.local`,
      siteUrl: `https://e2e-gate-${RUN}.example.com`,
      name: `E2E Gate ${RUN}`,
      workspace_id: WS_ID,
      // Provision avec un numéro de tracking d'appel (feature Calls).
      phoneNumbers: [{ e164: "+33199000000", source: "seo" }],
    });
    expect([200, 201]).toContain(status);
    expect(data.workspace_id).toBe(WS_ID);
    expect(data.api_key).toMatch(/^stam_live_/);
    // Le snippet doit pointer sur le vrai bundle tracker (/sdk/v1/tracker.js)
    // et porter le bon workspace id — sinon le client ne track rien.
    expect(data.snippet_html).toContain("/sdk/v1/tracker.js");
    expect(data.snippet_html).toContain(`data-workspace-id="${WS_ID}"`);
    provisioned = data;
  });

  test("2. workspaces.status → le tenant existe et est consolidé", async () => {
    if (!m2m) return;
    expect(provisioned, "provision must have succeeded").not.toBeNull();
    const res = await m2m.workspaceStatus(WS_ID);
    expect(res.status).toBe(200);
    const status = res.json<WorkspaceStatusResult>();
    expect(status.exists).toBe(true);
    expect(status.name).toContain("E2E Gate");
    // Les blocs connecteurs doivent être présents (même vides) — preuve que la
    // surface status native est câblée pour les 3 features.
    expect(status.gsc).not.toBeNull();
    expect(status.voip).not.toBeNull();
    expect(status.webhooks).not.toBeNull();
  });

  test("3. Feature TRACKING — ingestion round-trip ClickHouse réelle (dry-run, zéro pollution)", async () => {
    if (!m2m) return;
    expect(provisioned).not.toBeNull();
    // tracking.verify injecte un event synthétique dans la VRAIE chaîne
    // d'ingestion (validation → buffer → ClickHouse events → MV → requeryable)
    // puis le PURGE. C'est la preuve on-premise que le tracking marche
    // end-to-end contre le vrai ClickHouse — pas un mock.
    const res = await m2m.trackingVerify(WS_ID);
    expect(res.status).toBe(200);
    const v = res.json<TrackingVerifyResult>();
    expect(v.workspace_exists).toBe(true);
    expect(v.ingestion.ok, `ingestion detail: ${v.ingestion.detail}`).toBe(
      true,
    );
    expect(v.verdict).toBe("ok");
    // round-trip mesuré → preuve d'un aller-retour ClickHouse réel.
    expect(v.ingestion.round_trip_ms).toBeGreaterThan(0);
  });

  test("4. Feature TRACKING — /api/track public accepte un event réel", async () => {
    if (!m2m) return;
    expect(provisioned).not.toBeNull();
    // Surface publique réelle (le endpoint que le snippet client appelle).
    const now = Date.now();
    const res = await fetch(`${target.engineUrl}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: WS_ID,
        session_id: `e2e-gate-sess-${RUN}`,
        actions: [
          {
            type: "pageview",
            path: "/e2e-gate",
            page_number: 1,
            duration: 1000,
            scroll: 50,
            entered_at: now - 1500,
            exited_at: now - 500,
          },
        ],
        attributes: { landing_page: "/e2e-gate" },
        visitor_id: `e2e-gate-vis-${RUN}`,
        created_at: now - 2000,
        updated_at: now,
        sdk_version: "e2e-gate",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
  });

  test("5. Feature TRACKING — analytics.query est requêtable (shape valide)", async () => {
    if (!m2m) return;
    expect(provisioned).not.toBeNull();
    // On vérifie que la query répond avec une shape stable (data + meta). On
    // n'asserte PAS une valeur exacte de sessions : la matérialisation des MV
    // ClickHouse a une latence variable (la preuve d'ingestion = test 3).
    const res = await m2m.analyticsQuery(WS_ID, ["sessions"]);
    expect(res.status).toBe(200);
    const body = res.json<{
      data: Array<Record<string, unknown>>;
      meta: { metrics: string[] };
    }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.metrics).toContain("sessions");
  });

  test("6. Feature CALLS / VoIP — add + list phone number (par source)", async () => {
    if (!m2m) return;
    expect(provisioned).not.toBeNull();
    const addRes = await m2m.voipAddPhoneNumber(WS_ID, "+33199887766", "ads");
    expect(addRes.status).toBe(200);
    const added = addRes.json<{ ok: boolean; phoneNumber: { id: string } }>();
    expect(added.ok).toBe(true);
    expect(added.phoneNumber.id).toBeTruthy();

    const listRes = await m2m.voipListPhoneNumbers(WS_ID);
    expect(listRes.status).toBe(200);
    const list = listRes.json<{
      phoneNumbers: Array<{ e164: string; source: string }>;
      allowedSources: string[];
    }>();
    expect(list.phoneNumbers.some((p) => p.e164 === "+33199887766")).toBe(true);
    expect(list.allowedSources).toContain("ads");
  });

  test("7. Feature SEARCH CONSOLE — gsc.status répond (connecteur câblé)", async () => {
    if (!m2m) return;
    expect(provisioned).not.toBeNull();
    const res = await m2m.gscStatus(WS_ID);
    expect(res.status).toBe(200);
    const gsc = res.json<{ connected: boolean }>();
    // Fraîchement provisionné → non connecté (OAuth = action browser humaine),
    // mais le connecteur doit répondre une shape exploitable par une IA.
    expect(gsc).toHaveProperty("connected");
    expect(gsc.connected).toBe(false);
  });
});
