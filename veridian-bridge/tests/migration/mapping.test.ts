/**
 * Tests des fonctions de mapping legacy → bridge (scripts/migration/lib/mapping.ts).
 *
 * Cœur "à risque" de la migration D2 : un mauvais mapping = données corrompues
 * en prod. On teste chaque transformation en isolation, sans aucune DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toDate,
  toDateOrNull,
  deriveGscPropertyType,
  mapGscProperty,
  mapGscDaily,
  mapFormSchema,
  mapFormSubmission,
  mapLead,
  mapLeadSession,
  mapPushSubscription,
  deriveLegacyVisitorId,
} from "../../../scripts/migration/lib/mapping.js";

// ─── toDate / toDateOrNull ──────────────────────────────────────────────────

test("toDate : Date passe inchangée", () => {
  const d = new Date("2026-05-01T00:00:00Z");
  assert.equal(toDate(d).getTime(), d.getTime());
});

test("toDate : string ISO parsée", () => {
  assert.equal(
    toDate("2026-05-01T12:00:00Z").toISOString(),
    "2026-05-01T12:00:00.000Z",
  );
});

test("toDate : string invalide → throw", () => {
  assert.throws(() => toDate("pas-une-date"), /invalid date value/);
});

test("toDateOrNull : null → null", () => {
  assert.equal(toDateOrNull(null), null);
});

test("toDateOrNull : string → Date", () => {
  assert.ok(toDateOrNull("2026-05-01") instanceof Date);
});

// ─── deriveGscPropertyType ──────────────────────────────────────────────────

test("deriveGscPropertyType : sc-domain → DOMAIN", () => {
  assert.equal(deriveGscPropertyType("sc-domain:exemple.fr"), "DOMAIN");
});

test("deriveGscPropertyType : https → SITE", () => {
  assert.equal(deriveGscPropertyType("https://www.exemple.fr/"), "SITE");
});

// ─── mapGscProperty ─────────────────────────────────────────────────────────

test("mapGscProperty : propertyUrl → siteUrl, tenantId réécrit, type dérivé", () => {
  const out = mapGscProperty(
    {
      id: "gp_legacy_1",
      siteId: "site_legacy_1",
      propertyUrl: "sc-domain:morel-volailles.com",
      lastSyncAt: "2026-05-20T10:00:00Z",
    },
    "tnt_bridge_1",
  );
  assert.equal(out.id, "gp_legacy_1");
  assert.equal(out.tenantId, "tnt_bridge_1");
  assert.equal(out.siteUrl, "sc-domain:morel-volailles.com");
  assert.equal(out.type, "DOMAIN");
  assert.equal(out.ownershipState, "verified");
  assert.ok(out.lastSyncAt instanceof Date);
});

test("mapGscProperty : lastSyncAt null toléré", () => {
  const out = mapGscProperty(
    {
      id: "gp_2",
      siteId: "s",
      propertyUrl: "https://x.fr/",
      lastSyncAt: null,
    },
    "tnt",
  );
  assert.equal(out.lastSyncAt, null);
  assert.equal(out.type, "SITE");
});

// ─── mapGscDaily ────────────────────────────────────────────────────────────

test("mapGscDaily : day → date, gscPropertyId réécrit", () => {
  const out = mapGscDaily(
    {
      id: "gd_1",
      siteId: "site_legacy",
      day: "2026-05-15",
      query: "poulet fermier",
      page: "https://x.fr/poulet",
      country: "fra",
      device: "MOBILE",
      searchType: "web",
      clicks: 12,
      impressions: 340,
      ctr: 0.035,
      position: 4.2,
    },
    "gp_bridge_1",
  );
  assert.equal(out.gscPropertyId, "gp_bridge_1");
  assert.equal(out.date.toISOString().slice(0, 10), "2026-05-15");
  assert.equal(out.clicks, 12);
  assert.equal(out.impressions, 340);
  assert.equal(out.searchType, "web");
});

test("mapGscDaily : searchType vide → défaut 'web'", () => {
  const out = mapGscDaily(
    {
      id: "gd_2",
      siteId: "s",
      day: "2026-05-15",
      query: "",
      page: "",
      country: "",
      device: "",
      searchType: "",
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    },
    "gp",
  );
  assert.equal(out.searchType, "web");
});

// ─── mapFormSchema ──────────────────────────────────────────────────────────

test("mapFormSchema : formName → formSlug + name", () => {
  const out = mapFormSchema(
    { id: "fs_1", siteId: "site_legacy", formName: "contact-devis", fields: [] },
    "site_bridge_1",
  );
  assert.equal(out.siteId, "site_bridge_1");
  assert.equal(out.formSlug, "contact-devis");
  assert.equal(out.name, "contact-devis");
});

// ─── mapFormSubmission ──────────────────────────────────────────────────────

test("mapFormSubmission : payload → data, path → pageUrl, formName → formSlug", () => {
  const out = mapFormSubmission(
    {
      id: "sub_1",
      siteId: "site_legacy",
      formName: "contact",
      path: "/contact",
      payload: { email: "a@b.com", message: "hello" },
      email: "a@b.com",
      phone: null,
      sessionId: "sess_legacy_1",
      leadId: "lead_legacy_1",
      createdAt: "2026-05-10T08:00:00Z",
    },
    "site_bridge_1",
    "fs_bridge_1",
  );
  assert.equal(out.siteId, "site_bridge_1");
  assert.equal(out.formSchemaId, "fs_bridge_1");
  assert.equal(out.formSlug, "contact");
  assert.deepEqual(out.data, { email: "a@b.com", message: "hello" });
  assert.equal(out.pageUrl, "/contact");
  assert.equal(out.sessionId, "sess_legacy_1");
  assert.equal(out.leadId, "lead_legacy_1");
  // pas de visitor_id legacy.
  assert.equal(out.visitorId, null);
});

test("mapFormSubmission : leadId null toléré (formulaire anonyme)", () => {
  const out = mapFormSubmission(
    {
      id: "sub_2",
      siteId: "s",
      formName: "newsletter",
      path: null,
      payload: {},
      email: null,
      phone: null,
      sessionId: null,
      leadId: null,
      createdAt: "2026-05-10T08:00:00Z",
    },
    "site_bridge",
    null,
  );
  assert.equal(out.leadId, null);
  assert.equal(out.formSchemaId, null);
  assert.equal(out.pageUrl, null);
});

// ─── mapLead ────────────────────────────────────────────────────────────────

test("mapLead : tenantId legacy abandonné, siteId réécrit", () => {
  const out = mapLead(
    {
      id: "lead_1",
      tenantId: "tnt_legacy",
      siteId: "site_legacy",
      email: "client@exemple.fr",
      phone: "0102030405",
      name: "Jean Client",
      firstSeenAt: "2026-04-01T00:00:00Z",
      lastSeenAt: "2026-05-01T00:00:00Z",
    },
    "site_bridge_1",
  );
  assert.equal(out.id, "lead_1");
  assert.equal(out.siteId, "site_bridge_1");
  assert.equal(out.email, "client@exemple.fr");
  assert.equal(out.name, "Jean Client");
  // le bridge Lead n'a pas de tenantId — pas de fuite.
  assert.equal(
    (out as unknown as Record<string, unknown>).tenantId,
    undefined,
  );
});

// ─── mapLeadSession ─────────────────────────────────────────────────────────

test("mapLeadSession : sessionId réutilisé comme visitorId, dates portées", () => {
  const out = mapLeadSession({
    id: "ls_1",
    leadId: "lead_1",
    sessionId: "sess_xyz",
    siteId: "site_legacy",
    firstSeenAt: "2026-05-01T10:00:00Z",
    lastSeenAt: "2026-05-01T10:30:00Z",
    pageviewCount: 5,
  });
  assert.equal(out.leadId, "lead_1");
  assert.equal(out.sessionId, "sess_xyz");
  assert.equal(out.visitorId, "sess_xyz");
  assert.equal(out.pageviewCount, 5);
  assert.ok(out.startedAt instanceof Date);
  assert.ok(out.endedAt instanceof Date);
});

// ─── mapPushSubscription ────────────────────────────────────────────────────

test("mapPushSubscription : p256dh/auth plats → keys JSON", () => {
  const out = mapPushSubscription(
    {
      id: "ps_1",
      tenantId: "tnt_legacy",
      siteId: "site_legacy",
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: "BPxxxxx",
      auth: "AUTHxxxx",
      userAgent: "Mozilla/5.0",
      createdAt: "2026-05-01T00:00:00Z",
    },
    "tnt_bridge_1",
    "site_bridge_1",
  );
  assert.equal(out.tenantId, "tnt_bridge_1");
  assert.equal(out.siteId, "site_bridge_1");
  assert.equal(out.endpoint, "https://fcm.googleapis.com/fcm/send/abc");
  assert.deepEqual(out.keys, { p256dh: "BPxxxxx", auth: "AUTHxxxx" });
});

test("mapPushSubscription : siteId null toléré (push tenant-wide)", () => {
  const out = mapPushSubscription(
    {
      id: "ps_2",
      tenantId: "t",
      siteId: null,
      endpoint: "https://x/y",
      p256dh: "p",
      auth: "a",
      userAgent: null,
      createdAt: "2026-05-01T00:00:00Z",
    },
    "tnt_bridge",
    null,
  );
  assert.equal(out.siteId, null);
});

// ─── deriveLegacyVisitorId ──────────────────────────────────────────────────

test("deriveLegacyVisitorId : déterministe + préfixe vrd_legacy_", () => {
  assert.equal(deriveLegacyVisitorId("sess_abc"), "vrd_legacy_sess_abc");
  // Déterministe : même entrée → même sortie (pré-requis idempotence).
  assert.equal(
    deriveLegacyVisitorId("sess_abc"),
    deriveLegacyVisitorId("sess_abc"),
  );
});

test("deriveLegacyVisitorId : null → null", () => {
  assert.equal(deriveLegacyVisitorId(null), null);
});
