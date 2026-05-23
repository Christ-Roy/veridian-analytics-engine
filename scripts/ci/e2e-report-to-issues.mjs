#!/usr/bin/env node
/**
 * e2e-report-to-issues.mjs
 *
 * Parse le rapport Playwright JSON et crée automatiquement des issues GitHub
 * pour chaque test rouge avec tag `@critical` ou `@bug-XX`. Idempotent : si
 * une issue existe déjà avec le même titre (label `e2e-regression`), on
 * commente plutôt que de dupliquer.
 *
 * Sur un test précédemment rouge qui repasse vert : on ferme l'issue avec
 * commentaire "Fixed by run #XXX".
 *
 * Usage :
 *   node scripts/ci/e2e-report-to-issues.mjs \
 *     --report tests/e2e/playwright-report/results.json \
 *     --run-id $GITHUB_RUN_ID \
 *     --run-url $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID \
 *     --target staging
 *
 * Env vars :
 *   GITHUB_TOKEN   — requis (auto-injecté par actions/github-script ou gh CLI)
 *   GITHUB_REPOSITORY — owner/repo (auto)
 *
 * Output : crée/met à jour/ferme les issues. Imprime un résumé sur stdout.
 *
 * INSTRUCTIONS POUR LES AGENTS QUI PRENNENT UN TICKET :
 *   - Reproduire le test (`npx playwright test <chemin>:<ligne>`)
 *   - Fix le code applicatif (jamais le test sauf si test buggy)
 *   - Push staging — l'issue se ferme automatiquement au prochain run vert
 */

import fs from "node:fs/promises";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const REPORT = args.report ?? "tests/e2e/playwright-report/results.json";
const RUN_ID = args["run-id"] ?? process.env.GITHUB_RUN_ID ?? "local";
const RUN_URL =
  args["run-url"] ??
  (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${RUN_ID}`
    : "");
const TARGET = args.target ?? process.env.TARGET ?? "staging";
const REPO = process.env.GITHUB_REPOSITORY ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const DRY = args["dry-run"] === "true" || args.dry === "true";

if (!REPO) {
  console.error("ERROR: GITHUB_REPOSITORY required");
  process.exit(2);
}
if (!TOKEN && !DRY) {
  console.error("ERROR: GITHUB_TOKEN required (or pass --dry-run)");
  process.exit(2);
}

const [OWNER, REPO_NAME] = REPO.split("/");
const API = "https://api.github.com";

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

async function main() {
  // 1. Read playwright JSON report
  let report;
  try {
    const raw = await fs.readFile(REPORT, "utf8");
    report = JSON.parse(raw);
  } catch (err) {
    console.error(`Cannot read report ${REPORT}: ${err.message}`);
    process.exit(2);
  }

  // 2. Walk all tests, collect failures with tags @critical or @bug-XX
  const failed = [];
  const passed = [];
  walkSuites(report.suites ?? [], (test, spec, suite) => {
    const title = test.title ?? spec.title ?? "unknown";
    const fullTitle = buildFullTitle(suite, spec, test);
    const tags = extractTags(fullTitle);
    const isCritical = tags.has("critical");
    const bugTags = [...tags].filter((t) => /^bug-\d+/.test(t));

    // Get latest run result
    const results = test.results ?? [];
    const lastRun = results[results.length - 1];
    if (!lastRun) return;

    const passedRun = lastRun.status === "passed" || lastRun.status === "skipped";
    const failedRun =
      lastRun.status === "failed" ||
      lastRun.status === "timedOut" ||
      lastRun.status === "interrupted";

    if (failedRun && (isCritical || bugTags.length > 0)) {
      failed.push({
        title: fullTitle,
        file: spec.file ?? "unknown",
        line: spec.line ?? 0,
        error: lastRun.error?.message ?? lastRun.errors?.[0]?.message ?? "no error message",
        stack: lastRun.error?.stack ?? "",
        duration: lastRun.duration ?? 0,
        tags: [...tags],
        bugTags,
        isCritical,
      });
    }
    if (passedRun && (isCritical || bugTags.length > 0)) {
      passed.push({ title: fullTitle, tags: [...tags] });
    }
  });

  console.log(
    `E2E report parsed: ${failed.length} failed (critical/bug-tagged), ${passed.length} passed`,
  );

  // 3. List existing open issues with label e2e-regression
  const existing = await listIssues(["e2e-regression"]);
  console.log(`Existing open e2e-regression issues: ${existing.length}`);

  // 4. For each failure: create or comment on existing
  let created = 0;
  let commented = 0;
  for (const f of failed) {
    const issueTitle = `E2E regression: ${f.title}`;
    const existingIssue = existing.find((i) => i.title === issueTitle);
    const labels = ["e2e-regression", f.isCritical ? "p0" : "p1", TARGET, "bug"];
    for (const bugTag of f.bugTags) labels.push(bugTag);

    const body = renderIssueBody(f);

    if (existingIssue) {
      console.log(`  [exists #${existingIssue.number}] ${issueTitle}`);
      if (!DRY) {
        await commentIssue(existingIssue.number, renderRecurrenceComment(f));
        commented++;
      }
    } else {
      console.log(`  [new]    ${issueTitle}`);
      if (!DRY) {
        await createIssue({ title: issueTitle, body, labels });
        created++;
      }
    }
  }

  // 5. For each passed previously-tracked test: close issue if exists
  let closed = 0;
  for (const p of passed) {
    const issueTitle = `E2E regression: ${p.title}`;
    const existingIssue = existing.find((i) => i.title === issueTitle);
    if (existingIssue) {
      console.log(`  [close #${existingIssue.number}] ${issueTitle} (now green)`);
      if (!DRY) {
        await commentIssue(
          existingIssue.number,
          `Fixed by CI run [${RUN_ID}](${RUN_URL}). Closing.\n\nIf this test regresses again, the agent will reopen the issue.`,
        );
        await closeIssue(existingIssue.number);
        closed++;
      }
    }
  }

  console.log(
    `\nSummary: created=${created} commented=${commented} closed=${closed}${DRY ? " (DRY RUN)" : ""}`,
  );
}

function buildFullTitle(suite, spec, test) {
  const parts = [];
  if (suite?.title) parts.push(suite.title);
  if (spec?.title && spec.title !== suite?.title) parts.push(spec.title);
  if (test?.title && test.title !== spec?.title) parts.push(test.title);
  return parts.join(" › ");
}

function extractTags(title) {
  const tags = new Set();
  const re = /@([a-z0-9-]+)/gi;
  let m;
  while ((m = re.exec(title)) !== null) tags.add(m[1].toLowerCase());
  return tags;
}

function walkSuites(suites, fn) {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        fn(t, spec, suite);
      }
    }
    if (suite.suites) walkSuites(suite.suites, fn);
  }
}

function renderIssueBody(f) {
  return [
    `**Test échoué dans la suite E2E.**`,
    ``,
    `- File: \`${f.file}:${f.line}\``,
    `- Target: \`${TARGET}\``,
    `- Tags: ${f.tags.map((t) => `\`@${t}\``).join(", ")}`,
    `- Duration: ${f.duration}ms`,
    ``,
    `## Error`,
    "```",
    truncate(f.error, 2000),
    "```",
    f.stack
      ? `\n<details><summary>Stack trace</summary>\n\n\`\`\`\n${truncate(f.stack, 4000)}\n\`\`\`\n</details>\n`
      : "",
    ``,
    `## Repro`,
    "```bash",
    `cd tests/e2e`,
    `TARGET=${TARGET} npx playwright test ${f.file}:${f.line} --project=chromium-desktop`,
    "```",
    ``,
    `## CI Run`,
    RUN_URL ? `[Run #${RUN_ID}](${RUN_URL})` : `Run ID: ${RUN_ID}`,
    ``,
    `## What to do`,
    `1. Reproduire en local avec la commande ci-dessus`,
    `2. Fix le **code applicatif** (rarement le test — sauf si tu confirmes que le test est buggy)`,
    `3. Push sur \`staging\` — l'issue se ferme automatiquement quand le test repasse vert`,
    ``,
    `---`,
    `_Issue créée automatiquement par \`scripts/ci/e2e-report-to-issues.mjs\`. Ne pas modifier manuellement._`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderRecurrenceComment(f) {
  return [
    `Le test échoue encore au run [${RUN_ID}](${RUN_URL}).`,
    ``,
    `Erreur :`,
    "```",
    truncate(f.error, 1000),
    "```",
  ].join("\n");
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "\n... (truncated)" : s;
}

async function gh(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GH API ${opts.method ?? "GET"} ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function listIssues(labels) {
  const labelQuery = encodeURIComponent(labels.join(","));
  let issues = [];
  let page = 1;
  while (true) {
    const batch = await gh(
      `/repos/${OWNER}/${REPO_NAME}/issues?state=open&labels=${labelQuery}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    // Filter out PRs (issues API returns PRs too)
    issues = issues.concat(batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
    page++;
  }
  return issues;
}

async function createIssue({ title, body, labels }) {
  return gh(`/repos/${OWNER}/${REPO_NAME}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels }),
  });
}

async function commentIssue(number, body) {
  return gh(`/repos/${OWNER}/${REPO_NAME}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function closeIssue(number) {
  return gh(`/repos/${OWNER}/${REPO_NAME}/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}
