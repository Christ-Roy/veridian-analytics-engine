/**
 * ════════════════════════════════════════════════════════════════════════════
 * ingest-happy-path.integration.test.ts — T3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * POST /api/ingest/form contre un VRAI Postgres. Vérifie que la chaîne
 * complète `FormSubmission → Lead → LeadSession → FormSchema` est RÉELLEMENT
 * persistée — pas dans un FakePrismaClient. Chaque assertion relit la row
 * directement via `h.prisma`, ce qui prouve l'INSERT Postgres.
 *
 * Couvre aussi le push de l'event `form_submission` vers staminads : on monte
 * une vraie staminads (faux serveur HTTP du harness) et on vérifie que le
 * bridge a bien tapé `POST /api/track` avec le bon payload.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealStaminads,
  resetDb,
  seedTenant,
  seedSite,
  type StaminadsBridgeHarness,
} from "../_harness/index.js";
import { FakeStaminads } from "../../helpers/fake-staminads.js";

let h: StaminadsBridgeHarness;
let staminads: FakeStaminads;

// On monte une vraie staminads (faux serveur HTTP) pour vérifier le push réel
// de l'event form_submission. Postgres reste TOUJOURS réel.
before(async () => {
  staminads = new FakeStaminads();
  const staminadsUrl = await staminads.start();
  h = await bootBridgeWithRealStaminads({ staminadsUrl });
});

after(async () => {
  await h.close();
  await staminads.stop();
});

beforeEach(async () => {
  await resetDb(h.prisma);
  staminads.resetCalls();
  staminads.resetBehavior();
});

// ─── 1. POST happy path → tout est en Postgres ──────────────────────────────

test("happy: POST /api/ingest/form persiste FormSubmission + Lead + LeadSession", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_happy" });
  const site = await seedSite(h.prisma, tenant.id, { siteKey: "pk_happy" });

  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "pk_happy",
      formSlug: "contact-devis",
      formName: "Demande de devis",
      data: {
        email: "Alice@Example.COM",
        name: "Alice Martin",
        phone: "+33 6 12 34 56 78",
        message: "Je veux un devis",
      },
      visitorId: "visitor-abc",
      sessionId: "session-xyz",
      pageUrl: "https://client.fr/contact",
      utm: { source: "google", medium: "cpc", campaign: "devis-2026" },
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    submissionId: string;
    leadId: string;
    leadCreated: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(body.leadCreated, true);
  assert.ok(body.submissionId, "submissionId doit être renvoyé");
  assert.ok(body.leadId, "leadId doit être renvoyé");

  // ── FormSubmission RÉELLEMENT en Postgres ──
  const submission = await h.prisma.formSubmission.findUnique({
    where: { id: body.submissionId },
  });
  assert.ok(submission, "la FormSubmission doit être relisible depuis Postgres");
  assert.equal(submission.siteId, site.id);
  assert.equal(submission.formSlug, "contact-devis");
  assert.equal(submission.pageUrl, "https://client.fr/contact");
  assert.equal(submission.visitorId, "visitor-abc");
  assert.equal(submission.sessionId, "session-xyz");
  assert.equal(submission.leadId, body.leadId);
  assert.ok(submission.formSchemaId, "la submission doit être liée à un FormSchema");

  // ── Lead RÉELLEMENT en Postgres, email normalisé lowercase ──
  const lead = await h.prisma.lead.findUnique({ where: { id: body.leadId } });
  assert.ok(lead, "le Lead doit être relisible depuis Postgres");
  assert.equal(lead.email, "alice@example.com", "email lowercasé par extractLeadFields");
  assert.equal(lead.name, "Alice Martin");
  assert.equal(lead.phone, "+33 6 12 34 56 78");
  assert.equal(lead.submissionsCount, 1);
  assert.equal(lead.siteId, site.id);

  // ── LeadSession RÉELLEMENT créée, attribution UTM persistée ──
  const sessions = await h.prisma.leadSession.findMany({
    where: { leadId: body.leadId },
  });
  assert.equal(sessions.length, 1, "une LeadSession doit être créée");
  assert.equal(sessions[0].visitorId, "visitor-abc");
  assert.equal(sessions[0].sessionId, "session-xyz");
  assert.equal(sessions[0].source, "google");
  assert.equal(sessions[0].medium, "cpc");
  assert.equal(sessions[0].campaign, "devis-2026");
  assert.equal(sessions[0].pageviewCount, 1);

  // ── FormSchema auto-créé en Postgres ──
  const schema = await h.prisma.formSchema.findUnique({
    where: {
      siteId_formSlug: { siteId: site.id, formSlug: "contact-devis" },
    },
  });
  assert.ok(schema, "le FormSchema doit être auto-créé en Postgres");
  assert.equal(schema.name, "Demande de devis");
});

// ─── 2. L'event form_submission est poussé vers staminads ───────────────────

test("happy: l'event form_submission est RÉELLEMENT poussé vers staminads", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_staminads" });
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_staminads" });

  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "pk_staminads",
      formSlug: "newsletter",
      data: { email: "bob@example.com" },
      pageUrl: "https://client.fr/blog",
    }),
  });
  assert.equal(res.status, 200);

  // Le bridge a réellement tapé staminads sur /api/track.
  const trackCalls = staminads.getCalls().filter((c) => c.path === "/api/track");
  assert.equal(trackCalls.length, 1, "exactement un POST /api/track attendu");

  const payload = trackCalls[0].body as {
    workspace_id: string;
    actions: Array<{ type: string; name: string }>;
    attributes: { form_slug: string; lead_id: string; submission_id: string };
  };
  assert.equal(payload.workspace_id, "ws_staminads");
  assert.equal(payload.actions[0].type, "goal");
  assert.equal(payload.actions[0].name, "form_submission");
  assert.equal(payload.attributes.form_slug, "newsletter");
  assert.ok(payload.attributes.lead_id, "lead_id doit être renseigné dans l'event");
  assert.ok(payload.attributes.submission_id, "submission_id doit être renseigné");
});

// ─── 3. POST sans email → submission persistée, AUCUN lead ──────────────────

test("happy: POST sans email → FormSubmission persistée mais leadId null", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_noemail" });
  const site = await seedSite(h.prisma, tenant.id, { siteKey: "pk_noemail" });

  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "pk_noemail",
      formSlug: "feedback",
      data: { rating: 5, comment: "super site" },
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { leadId: string | null; leadCreated: boolean };
  assert.equal(body.leadId, null, "pas d'email → pas de lead");
  assert.equal(body.leadCreated, false);

  // La submission existe quand même.
  const submissions = await h.prisma.formSubmission.findMany({
    where: { siteId: site.id },
  });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].leadId, null);
  assert.equal(await h.prisma.lead.count(), 0, "aucun Lead ne doit exister");
});

// ─── 4. Body invalide → 400, rien en DB ─────────────────────────────────────

test("happy: body sans siteKey → 400 invalid_body, rien persisté", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id);

  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ formSlug: "x", data: { email: "x@y.fr" } }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_body");
  assert.equal(await h.prisma.formSubmission.count(), 0);
  assert.equal(await h.prisma.lead.count(), 0);
});
