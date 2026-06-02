#!/usr/bin/env node
/**
 * Provision a workspace directly (no JWT auth, no user, no API key).
 *
 * Use case: pre-existing workspaces for static Veridian sites (veridian-site,
 * vergers, etc.) that ingest events via the tracker SDK using only the
 * workspace_id. No human user owns these workspaces — they are platform-managed.
 *
 * Runs INSIDE the engine container (Node + @clickhouse/client lib + compiled
 * schemas.js are already present). Invoked via:
 *
 *   docker exec <engine-container> node /app/scripts/provision-workspace.js \
 *     --id=vrd_veridian_site_staging \
 *     --name="Veridian Site (staging)" \
 *     --website=https://staging.veridian.site \
 *     [--timezone=Europe/Paris] [--currency=EUR]
 *
 * Idempotent: if the workspace row already exists (id present in
 * staminads_system.workspaces), the script logs a warning and exits 0.
 * The workspace database CREATE statements are all `CREATE … IF NOT EXISTS`
 * so re-running is safe.
 *
 * Spec source of truth: WorkspacesService.create()
 * (api/src/workspaces/workspaces.service.ts) — we mirror its steps 1+2:
 *   1. createWorkspaceDatabase  (DB + tables/MVs)
 *   2. insert into staminads_system.workspaces  (status=active)
 *
 * We skip step 3 (workspace_memberships) deliberately: no human owner for
 * platform-managed workspaces. Super admins still see this workspace
 * via the "all workspaces" branch in WorkspacesService.list().
 *
 * We skip step 4 (backfill_tasks) deliberately: no filters configured,
 * so no "out of sync" UI warning to suppress.
 */

const { createClient } = require('@clickhouse/client');
const { WORKSPACE_SCHEMAS, SYSTEM_SCHEMAS } = require('/app/dist/database/schemas.js');

// ---- CLI parsing ----------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const args = parseArgs(process.argv);

const id = args.id;
const name = args.name;
const website = args.website;
const timezone = args.timezone || 'Europe/Paris';
const currency = args.currency || 'EUR';

if (!id || !name || !website) {
  console.error('Usage: node provision-workspace.js --id=<id> --name=<name> --website=<url> [--timezone=Europe/Paris] [--currency=EUR]');
  process.exit(2);
}

// Validate id matches CreateWorkspaceDto regex.
if (!/^[a-z][a-z0-9_]*$/.test(id)) {
  console.error(`Invalid id "${id}": must match /^[a-z][a-z0-9_]*$/`);
  process.exit(2);
}
if (id.length < 2 || id.length > 50) {
  console.error(`Invalid id "${id}": length must be 2..50`);
  process.exit(2);
}

// ---- ClickHouse connection ------------------------------------------------

const host = process.env.CLICKHOUSE_HOST;
const username = process.env.CLICKHOUSE_USER || 'default';
const password = process.env.CLICKHOUSE_PASSWORD || '';
const systemDb = process.env.CLICKHOUSE_SYSTEM_DATABASE || 'staminads_system';

if (!host) {
  console.error('CLICKHOUSE_HOST env var is required');
  process.exit(2);
}

const client = createClient({
  url: host,
  username,
  password,
  database: systemDb,
});

const workspaceDb = `staminads_ws_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

async function main() {
  // ---- Idempotency check --------------------------------------------------
  const existingRes = await client.query({
    query: `SELECT id FROM ${systemDb}.workspaces WHERE id = {id:String} LIMIT 1`,
    query_params: { id },
    format: 'JSONEachRow',
  });
  const existing = await existingRes.json();
  if (existing.length > 0) {
    console.log(`[provision] workspace ${id} already exists in ${systemDb}.workspaces — skipping row INSERT, ensuring DB tables exist`);
  }

  // ---- 1. Create workspace database + tables ------------------------------
  console.log(`[provision] CREATE DATABASE IF NOT EXISTS ${workspaceDb}`);
  await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${workspaceDb}` });

  for (const [tableName, schemaSql] of Object.entries(WORKSPACE_SCHEMAS)) {
    const sql = schemaSql.replace(/{database}/g, workspaceDb);
    console.log(`[provision]   create table/view: ${workspaceDb}.${tableName}`);
    await client.command({ query: sql });
  }

  // ---- 2. Insert workspace row (skip if already exists) -------------------
  if (existing.length === 0) {
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const defaultSettings = {
      timescore_reference: 60,
      bounce_threshold: 10,
      geo_enabled: true,
      geo_store_city: true,
      geo_store_region: true,
      geo_coordinates_precision: 1,
      filters: [],
      annotations: [],
      integrations: [],
      goal_definitions: [],
    };
    console.log(`[provision] INSERT row into ${systemDb}.workspaces`);
    await client.insert({
      table: `${systemDb}.workspaces`,
      values: [{
        id,
        name,
        website,
        timezone,
        currency,
        logo_url: null,
        settings: JSON.stringify(defaultSettings),
        status: 'active', // skip 'initializing' — no user-driven first-event flow
        created_at: now,
        updated_at: now,
      }],
      format: 'JSONEachRow',
    });
  }

  console.log(`[provision] ✓ workspace ${id} provisioned (DB: ${workspaceDb})`);
  await client.close();
}

main().catch(async (err) => {
  console.error('[provision] FAILED:', err.message);
  console.error(err.stack);
  try { await client.close(); } catch {}
  process.exit(1);
});
