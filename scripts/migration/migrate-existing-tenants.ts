#!/usr/bin/env -S npx tsx
/**
 * migrate-existing-tenants.ts — provisionning des 5 clients prod (ticket D2).
 *
 * Pour chaque client de `lib/clients.ts` :
 *   1. Appelle `POST <bridge>/api/admin/provision-existing-tenant` avec le
 *      siteKey legacy → crée le workspace staminads + Tenant/Site bridge.
 *   2. Récupère le mapping `legacySiteKey → workspaceId + apiKey`.
 *   3. Génère le snippet dual-tracking à coller côté site.
 *   4. Écrit `out/snippets-by-site.md` (un bloc par client).
 *
 * IDEMPOTENT : l'endpoint provision-existing-tenant renvoie le mapping
 * existant si le Site a déjà été adopté (created:false). Rejouer le script
 * ne crée jamais de doublon.
 *
 * DRY-RUN par défaut. Le script :
 *   - dry-run  : affiche ce qui serait provisionné, n'appelle PAS le bridge.
 *   - --apply  : appelle réellement le bridge.
 *
 * Variables d'environnement :
 *   BRIDGE_URL             — base URL du bridge (ex: https://analytics-engine-bridge.app.veridian.site)
 *   VERIDIAN_ADMIN_API_KEY — Bearer admin du bridge
 *
 * Usage :
 *   npx tsx scripts/migration/migrate-existing-tenants.ts            # dry-run
 *   npx tsx scripts/migration/migrate-existing-tenants.ts --apply    # exécute
 *   npx tsx scripts/migration/migrate-existing-tenants.ts --apply --limit=1
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS_TO_MIGRATE, unresolvedClients } from "./lib/clients.js";
import { buildDualTrackingBlock } from "./lib/dual-tracking.js";
import { parseFlags, makeLogger, modeBanner } from "./lib/cli.js";

const log = makeLogger("migrate-existing-tenants");
const HERE = dirname(fileURLToPath(import.meta.url));

interface ProvisionResponse {
  tenantId: string;
  workspaceId: string;
  siteId: string;
  siteKey: string;
  apiKey: string | null;
  snippet: string;
  dashboardUrl: string;
  created: boolean;
}

async function provisionViaBridge(
  bridgeUrl: string,
  adminKey: string,
  body: {
    siteKey: string;
    slug: string;
    domain: string;
    visitorIdEnabled: boolean;
  },
): Promise<ProvisionResponse> {
  const res = await fetch(
    `${bridgeUrl.replace(/\/+$/, "")}/api/admin/provision-existing-tenant`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `provision-existing-tenant ${body.slug} failed: ${res.status} ${text}`,
    );
  }
  return (await res.json()) as ProvisionResponse;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  log.info(modeBanner(flags));

  const STAMINADS_PUBLIC =
    process.env.PUBLIC_STAMINADS_URL ??
    "https://analytics-engine.app.veridian.site";
  const LEGACY_PUBLIC =
    process.env.LEGACY_INGEST_URL ?? "https://analytics.app.veridian.site";

  // ─── Garde : siteKey legacy non résolus ─────────────────────────────────
  const unresolved = unresolvedClients();
  if (unresolved.length > 0) {
    log.warn(
      `${unresolved.length} client(s) ont un siteKey legacy non résolu (placeholder RESOLVE_*) :`,
    );
    for (const c of unresolved) log.warn(`  - ${c.slug} (${c.legacySiteKey})`);
    if (!flags.dryRun) {
      log.error(
        "Refus de tourner en --apply avec des siteKey non résolus. " +
          "Voir CHECKLIST.md → 'Résoudre les siteKey legacy'.",
      );
      process.exit(1);
    }
    log.warn("Dry-run toléré — les siteKey RESOLVE_* sont affichés tels quels.");
  }

  let clients = CLIENTS_TO_MIGRATE;
  if (flags.limit) clients = clients.slice(0, flags.limit);

  // ─── Provisionning ──────────────────────────────────────────────────────
  const results: Array<{
    slug: string;
    domain: string;
    hosting: string;
    response: ProvisionResponse | null;
  }> = [];

  for (const client of clients) {
    log.info(`→ ${client.slug} (${client.domain}, ${client.hosting})`);

    if (flags.dryRun) {
      log.info(
        `  [dry-run] POST /api/admin/provision-existing-tenant ` +
          `{ siteKey:"${client.legacySiteKey}", slug:"${client.slug}", ` +
          `domain:"${client.domain}", visitorIdEnabled:true }`,
      );
      results.push({
        slug: client.slug,
        domain: client.domain,
        hosting: client.hosting,
        response: null,
      });
      continue;
    }

    const bridgeUrl = process.env.BRIDGE_URL;
    const adminKey = process.env.VERIDIAN_ADMIN_API_KEY;
    if (!bridgeUrl || !adminKey) {
      log.error("BRIDGE_URL et VERIDIAN_ADMIN_API_KEY requis en mode --apply");
      process.exit(1);
    }

    const response = await provisionViaBridge(bridgeUrl, adminKey, {
      siteKey: client.legacySiteKey,
      slug: client.slug,
      domain: client.domain,
      visitorIdEnabled: true,
    });
    log.ok(
      `  ${client.slug} → workspace ${response.workspaceId} ` +
        `(${response.created ? "créé" : "déjà existant — idempotent"})`,
    );
    results.push({
      slug: client.slug,
      domain: client.domain,
      hosting: client.hosting,
      response,
    });
  }

  // ─── Génération du fichier snippets-by-site.md ──────────────────────────
  const outDir = join(HERE, "out");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "snippets-by-site.md");

  const lines: string[] = [
    "# Snippets dual-tracking par site — migration D2",
    "",
    `> Généré le ${new Date().toISOString()} ` +
      `(${flags.dryRun ? "DRY-RUN — workspaceId fictif" : "APPLY"})`,
    "",
    "Coller le bloc staminads dans le `<head>` du site, **EN PLUS** du tracker",
    "legacy déjà en place. Ne PAS retirer le tracker legacy avant le cutover J+30.",
    "",
  ];

  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    const r = results[i].response;
    const workspaceId = r?.workspaceId ?? `<dry-run:${client.slug}>`;
    lines.push(`## ${client.slug} — ${client.domain}`);
    lines.push("");
    lines.push(`- Hosting : **${client.hosting}**`);
    lines.push(`- siteKey legacy : \`${client.legacySiteKey}\``);
    lines.push(`- workspaceId staminads : \`${workspaceId}\``);
    if (r) lines.push(`- dashboard : ${r.dashboardUrl}`);
    if (client.externalContact)
      lines.push(`- contact externe : ${client.externalContact}`);
    lines.push("");
    lines.push("```html");
    lines.push(
      buildDualTrackingBlock({
        workspaceId,
        legacySiteKey: client.legacySiteKey,
        staminadsEndpoint: STAMINADS_PUBLIC,
        legacyEndpoint: LEGACY_PUBLIC,
        visitorIdEnabled: true,
      }),
    );
    lines.push("```");
    lines.push("");
  }

  writeFileSync(outFile, lines.join("\n"), "utf8");
  log.ok(`Snippets écrits → ${outFile}`);
  log.info(
    flags.dryRun
      ? "Dry-run terminé. Aucune écriture en base. Relancer avec --apply."
      : `Provisionning terminé : ${results.filter((r) => r.response?.created).length} créé(s), ` +
          `${results.filter((r) => r.response && !r.response.created).length} déjà existant(s).`,
  );
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
