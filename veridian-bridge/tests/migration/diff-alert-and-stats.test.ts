/**
 * Tests de la logique d'alerting dual-tracking + stats forms + I/O des dumps.
 *
 * Couvre :
 *   - scripts/migration/lib/diff-alert.ts   — seuil 10 % / 3 jours consécutifs
 *   - scripts/migration/lib/forms-stats.ts  — recompte submissionsCount
 *   - scripts/migration/lib/dump-io.ts      — lecture JSON array + NDJSON
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  relativeDiffPct,
  diffSeverity,
  evaluateTenantAlert,
  tenantsToAlert,
  buildAlertMessage,
  type TenantDiffSeries,
} from "../../../scripts/migration/lib/diff-alert.js";
import { countSubmissionsPerLead } from "../../../scripts/migration/lib/forms-stats.js";
import {
  readDumpFile,
  filterBySiteId,
} from "../../../scripts/migration/lib/dump-io.js";

// ─── relativeDiffPct ────────────────────────────────────────────────────────

test("relativeDiffPct : écart classique", () => {
  // legacy 100, staminads 95 → 5 %
  assert.equal(
    relativeDiffPct({ date: "d", pageviewsLegacy: 100, pageviewsStaminads: 95 }),
    5,
  );
});

test("relativeDiffPct : legacy 0 + staminads 0 → 0 %", () => {
  assert.equal(
    relativeDiffPct({ date: "d", pageviewsLegacy: 0, pageviewsStaminads: 0 }),
    0,
  );
});

test("relativeDiffPct : legacy 0 + staminads > 0 → 100 %", () => {
  assert.equal(
    relativeDiffPct({ date: "d", pageviewsLegacy: 0, pageviewsStaminads: 7 }),
    100,
  );
});

test("relativeDiffPct : écart symétrique (staminads au-dessus)", () => {
  // legacy 100, staminads 120 → 20 %
  assert.equal(
    relativeDiffPct({
      date: "d",
      pageviewsLegacy: 100,
      pageviewsStaminads: 120,
    }),
    20,
  );
});

// ─── diffSeverity ───────────────────────────────────────────────────────────

test("diffSeverity : couleurs feu vert/jaune/rouge", () => {
  assert.equal(diffSeverity(2), "green");
  assert.equal(diffSeverity(5), "yellow");
  assert.equal(diffSeverity(9.9), "yellow");
  assert.equal(diffSeverity(10.1), "red");
});

// ─── evaluateTenantAlert ────────────────────────────────────────────────────

function series(
  tenant: string,
  pcts: Array<[string, number, number]>,
): TenantDiffSeries {
  return {
    tenant,
    points: pcts.map(([date, legacy, staminads]) => ({
      date,
      pageviewsLegacy: legacy,
      pageviewsStaminads: staminads,
    })),
  };
}

test("evaluateTenantAlert : 3 jours consécutifs > 10 % → alerte", () => {
  const s = series("avse", [
    ["2026-05-20", 100, 100], // 0 %
    ["2026-05-21", 100, 80], // 20 %
    ["2026-05-22", 100, 70], // 30 %
    ["2026-05-23", 100, 85], // 15 %
  ]);
  const r = evaluateTenantAlert(s);
  assert.equal(r.shouldAlert, true);
  assert.equal(r.consecutiveBreaches, 3);
});

test("evaluateTenantAlert : 2 jours consécutifs seulement → pas d'alerte", () => {
  const s = series("morel", [
    ["2026-05-20", 100, 100], // 0 %
    ["2026-05-21", 100, 100], // 0 %
    ["2026-05-22", 100, 80], // 20 %
    ["2026-05-23", 100, 70], // 30 %
  ]);
  const r = evaluateTenantAlert(s);
  assert.equal(r.shouldAlert, false);
  assert.equal(r.consecutiveBreaches, 2);
});

test("evaluateTenantAlert : dépassement RÉSOLU récemment → pas d'alerte", () => {
  // 3 jours rouges PUIS un jour vert → la série terminante est verte.
  const s = series("robert", [
    ["2026-05-20", 100, 70], // 30 %
    ["2026-05-21", 100, 70], // 30 %
    ["2026-05-22", 100, 70], // 30 %
    ["2026-05-23", 100, 98], // 2 % → résolu
  ]);
  const r = evaluateTenantAlert(s);
  assert.equal(r.shouldAlert, false);
  assert.equal(r.consecutiveBreaches, 0);
});

test("evaluateTenantAlert : tri par date — ordre d'entrée inversé géré", () => {
  const s = series("tram", [
    ["2026-05-23", 100, 70], // 30 %
    ["2026-05-21", 100, 70], // 30 %
    ["2026-05-22", 100, 70], // 30 %
  ]);
  const r = evaluateTenantAlert(s);
  assert.equal(r.consecutiveBreaches, 3);
  assert.equal(r.shouldAlert, true);
});

test("evaluateTenantAlert : seuil custom respecté", () => {
  const s = series("x", [
    ["2026-05-21", 100, 94], // 6 %
    ["2026-05-22", 100, 94], // 6 %
  ]);
  // seuil 5 % / 2 jours → alerte
  assert.equal(
    evaluateTenantAlert(s, { thresholdPct: 5, consecutiveDays: 2 }).shouldAlert,
    true,
  );
  // seuil 10 % / 2 jours → pas d'alerte
  assert.equal(evaluateTenantAlert(s).shouldAlert, false);
});

test("evaluateTenantAlert : série vide → pas d'alerte", () => {
  const r = evaluateTenantAlert({ tenant: "vide", points: [] });
  assert.equal(r.shouldAlert, false);
  assert.equal(r.latestDiffPct, 0);
});

// ─── tenantsToAlert + buildAlertMessage ─────────────────────────────────────

test("tenantsToAlert : ne retourne que les tenants en alerte", () => {
  const ok = series("ok", [
    ["2026-05-21", 100, 100],
    ["2026-05-22", 100, 100],
    ["2026-05-23", 100, 100],
  ]);
  const bad = series("bad", [
    ["2026-05-21", 100, 70],
    ["2026-05-22", 100, 70],
    ["2026-05-23", 100, 70],
  ]);
  const alerts = tenantsToAlert([ok, bad]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tenant, "bad");
});

test("buildAlertMessage : aucun alerte → message rassurant", () => {
  assert.match(buildAlertMessage([]), /sous le seuil/);
});

test("buildAlertMessage : alertes → mentionne tenant + cutover", () => {
  const msg = buildAlertMessage([
    {
      tenant: "avse",
      shouldAlert: true,
      consecutiveBreaches: 3,
      latestDiffPct: 28.4,
    },
  ]);
  assert.match(msg, /avse/);
  assert.match(msg, /28\.4/);
  assert.match(msg, /cutover/i);
});

// ─── countSubmissionsPerLead ────────────────────────────────────────────────

test("countSubmissionsPerLead : compte par leadId", () => {
  const counts = countSubmissionsPerLead([
    { id: "s1", leadId: "lead_a" },
    { id: "s2", leadId: "lead_a" },
    { id: "s3", leadId: "lead_b" },
  ]);
  assert.equal(counts.get("lead_a"), 2);
  assert.equal(counts.get("lead_b"), 1);
});

test("countSubmissionsPerLead : submissions sans leadId ignorées", () => {
  const counts = countSubmissionsPerLead([
    { id: "s1", leadId: null },
    { id: "s2", leadId: "lead_a" },
  ]);
  assert.equal(counts.get("lead_a"), 1);
  assert.equal(counts.size, 1);
});

test("countSubmissionsPerLead : liste vide → Map vide", () => {
  assert.equal(countSubmissionsPerLead([]).size, 0);
});

// ─── dump-io ────────────────────────────────────────────────────────────────

test("readDumpFile : JSON array", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrd-mig-"));
  const f = join(dir, "array.json");
  writeFileSync(f, JSON.stringify([{ id: "1" }, { id: "2" }]));
  const rows = readDumpFile<{ id: string }>(f);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "1");
});

test("readDumpFile : NDJSON (un objet par ligne)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrd-mig-"));
  const f = join(dir, "ndjson.json");
  writeFileSync(f, '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
  const rows = readDumpFile<{ id: string }>(f);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a", "b", "c"],
  );
});

test("readDumpFile : fichier vide → tableau vide", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrd-mig-"));
  const f = join(dir, "empty.json");
  writeFileSync(f, "");
  assert.deepEqual(readDumpFile(f), []);
});

test("readDumpFile : fichier introuvable → throw", () => {
  assert.throws(
    () => readDumpFile("/nonexistent/path/dump.json"),
    /introuvable/,
  );
});

test("readDumpFile : NDJSON ligne corrompue → throw avec n° de ligne", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrd-mig-"));
  const f = join(dir, "bad.json");
  writeFileSync(f, '{"id":"a"}\n{pas du json}\n');
  assert.throws(() => readDumpFile(f), /ligne 2/);
});

test("filterBySiteId : ne garde que le siteId demandé", () => {
  const rows = [
    { id: "1", siteId: "site_a" },
    { id: "2", siteId: "site_b" },
    { id: "3", siteId: "site_a" },
  ];
  const out = filterBySiteId(rows, "site_a");
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((r) => r.id),
    ["1", "3"],
  );
});
