/**
 * Tests des helpers CLI + génération de snippets dual-tracking + clients.
 *
 * Couvre :
 *   - scripts/migration/lib/cli.ts        — parsing flags, garde dry-run
 *   - scripts/migration/lib/dual-tracking.ts — snippets legacy/staminads
 *   - scripts/migration/lib/clients.ts    — liste 5 clients + garde placeholder
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlags,
  modeBanner,
  makeLogger,
} from "../../../scripts/migration/lib/cli.js";
import {
  buildStaminadsSnippet,
  buildLegacySnippet,
  buildDualTrackingBlock,
} from "../../../scripts/migration/lib/dual-tracking.js";
import {
  CLIENTS_TO_MIGRATE,
  isPlaceholderSiteKey,
  unresolvedClients,
  SITEKEY_PLACEHOLDER_PREFIX,
} from "../../../scripts/migration/lib/clients.js";

// ─── parseFlags ─────────────────────────────────────────────────────────────

test("parseFlags : défaut = dry-run (sécurité)", () => {
  const f = parseFlags([]);
  assert.equal(f.dryRun, true);
  assert.equal(f.limit, null);
  assert.equal(f.verbose, false);
});

test("parseFlags : --apply désactive le dry-run", () => {
  assert.equal(parseFlags(["--apply"]).dryRun, false);
});

test("parseFlags : --dry-run explicite reste dry-run", () => {
  assert.equal(parseFlags(["--dry-run"]).dryRun, true);
});

test("parseFlags : --apply + --dry-run ensemble → throw", () => {
  assert.throws(
    () => parseFlags(["--apply", "--dry-run"]),
    /mutuellement exclusifs/,
  );
});

test("parseFlags : --limit=3 parsé", () => {
  assert.equal(parseFlags(["--limit=3"]).limit, 3);
});

test("parseFlags : --limit invalide → throw", () => {
  assert.throws(() => parseFlags(["--limit=0"]), /limit invalide/);
  assert.throws(() => parseFlags(["--limit=abc"]), /limit invalide/);
});

test("parseFlags : --verbose / -v", () => {
  assert.equal(parseFlags(["--verbose"]).verbose, true);
  assert.equal(parseFlags(["-v"]).verbose, true);
});

test("modeBanner : dry-run vs apply distincts", () => {
  assert.match(modeBanner(parseFlags([])), /DRY-RUN/);
  assert.match(modeBanner(parseFlags(["--apply"])), /APPLY/);
});

test("makeLogger : retourne les 4 niveaux", () => {
  const log = makeLogger("test-script");
  assert.equal(typeof log.info, "function");
  assert.equal(typeof log.warn, "function");
  assert.equal(typeof log.error, "function");
  assert.equal(typeof log.ok, "function");
});

// ─── buildStaminadsSnippet ──────────────────────────────────────────────────

test("buildStaminadsSnippet : embarque workspaceId + endpoint", () => {
  const s = buildStaminadsSnippet({
    workspaceId: "morel_volailles_com",
    staminadsEndpoint: "https://analytics-engine.app.veridian.site",
    visitorIdEnabled: true,
  });
  assert.match(s, /data-workspace-id="morel_volailles_com"/);
  assert.match(s, /analytics-engine\.app\.veridian\.site\/api\/track/);
  assert.match(s, /data-visitor-id="true"/);
});

test("buildStaminadsSnippet : visitorIdEnabled=false → pas d'attribut", () => {
  const s = buildStaminadsSnippet({
    workspaceId: "w",
    staminadsEndpoint: "https://x.fr",
    visitorIdEnabled: false,
  });
  assert.equal(/data-visitor-id/.test(s), false);
});

test("buildStaminadsSnippet : slash final retiré de l'endpoint", () => {
  const s = buildStaminadsSnippet({
    workspaceId: "w",
    staminadsEndpoint: "https://x.fr/",
    visitorIdEnabled: false,
  });
  assert.equal(s.includes("https://x.fr//"), false);
  assert.match(s, /https:\/\/x\.fr\/api\/track/);
});

// ─── buildLegacySnippet ─────────────────────────────────────────────────────

test("buildLegacySnippet : embarque le siteKey legacy", () => {
  const s = buildLegacySnippet({
    legacySiteKey: "sk_abc123",
    legacyEndpoint: "https://analytics.app.veridian.site",
  });
  assert.match(s, /data-site-key="sk_abc123"/);
});

// ─── buildDualTrackingBlock ─────────────────────────────────────────────────

test("buildDualTrackingBlock : contient les DEUX trackers", () => {
  const block = buildDualTrackingBlock({
    workspaceId: "w_1",
    legacySiteKey: "sk_1",
    staminadsEndpoint: "https://engine.fr",
    legacyEndpoint: "https://legacy.fr",
    visitorIdEnabled: true,
  });
  assert.match(block, /data-site-key="sk_1"/); // legacy
  assert.match(block, /data-workspace-id="w_1"/); // staminads
  assert.match(block, /legacy/i);
  assert.match(block, /staminads/i);
});

// ─── clients ────────────────────────────────────────────────────────────────

test("CLIENTS_TO_MIGRATE : exactement 5 clients", () => {
  assert.equal(CLIENTS_TO_MIGRATE.length, 5);
});

test("CLIENTS_TO_MIGRATE : 3 veridian-hosted + 2 external", () => {
  const veridian = CLIENTS_TO_MIGRATE.filter((c) => c.hosting === "veridian");
  const external = CLIENTS_TO_MIGRATE.filter((c) => c.hosting === "external");
  assert.equal(veridian.length, 3);
  assert.equal(external.length, 2);
});

test("CLIENTS_TO_MIGRATE : les 2 external ont un contact", () => {
  for (const c of CLIENTS_TO_MIGRATE.filter((x) => x.hosting === "external")) {
    assert.ok(c.externalContact, `${c.slug} doit avoir un externalContact`);
  }
});

test("CLIENTS_TO_MIGRATE : slugs uniques", () => {
  const slugs = CLIENTS_TO_MIGRATE.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("isPlaceholderSiteKey : RESOLVE_* détecté", () => {
  assert.equal(isPlaceholderSiteKey(`${SITEKEY_PLACEHOLDER_PREFIX}foo`), true);
  assert.equal(isPlaceholderSiteKey("sk_real_key"), false);
});

test("unresolvedClients : tous placeholders au départ (avant résolution)", () => {
  // La liste livrée a des placeholders → tous non résolus tant que
  // l'opérateur n'a pas remplacé les siteKey.
  const unresolved = unresolvedClients();
  assert.equal(unresolved.length, 5);
});

test("unresolvedClients : ne retourne que les non résolus", () => {
  const mixed = [
    { ...CLIENTS_TO_MIGRATE[0], legacySiteKey: "sk_resolved" },
    { ...CLIENTS_TO_MIGRATE[1] }, // placeholder
  ];
  assert.equal(unresolvedClients(mixed).length, 1);
  assert.equal(unresolvedClients(mixed)[0].slug, CLIENTS_TO_MIGRATE[1].slug);
});
