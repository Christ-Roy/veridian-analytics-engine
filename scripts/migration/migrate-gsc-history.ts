#!/usr/bin/env -S npx tsx
/**
 * migrate-gsc-history.ts — import de l'historique GSC legacy vers le bridge.
 *
 * Optionnel (ticket D2 §6) : conserve l'historique Search Console côté
 * staminads/bridge pour ne pas repartir de zéro sur la courbe SEO.
 *
 * Flux :
 *   1. Lit les dumps JSON legacy `analytics.GscProperty` + `analytics.GscDaily`
 *      (produits par l'opérateur — cf. README.md "Produire les dumps legacy").
 *   2. Pour chaque client de `lib/clients.ts` :
 *      - Résout le `Site` bridge via le siteKey legacy (doit déjà exister —
 *        provisionné par migrate-existing-tenants.ts).
 *      - Filtre les rows legacy du `legacySiteId` correspondant.
 *      - Transforme via `lib/mapping.ts`.
 *      - Upsert idempotent dans `bridge.GscProperty` + `bridge.GscDaily`.
 *
 * IDEMPOTENT : upsert sur les contraintes @@unique du bridge
 *   - GscProperty : (tenantId, siteUrl)
 *   - GscDaily    : (gscPropertyId, date, query, page, country, device, searchType)
 * Rejouer le script ne duplique aucune row.
 *
 * DRY-RUN par défaut — n'écrit qu'avec --apply.
 *
 * Variables d'environnement :
 *   BRIDGE_DATABASE_URL — Postgres du bridge (cible)
 *   GSC_PROPERTY_DUMP   — chemin du dump JSON analytics.GscProperty
 *   GSC_DAILY_DUMP      — chemin du dump JSON analytics.GscDaily
 *   LEGACY_SITE_DUMP    — chemin du dump JSON analytics.Site (résolution siteId↔siteKey)
 *
 * Usage :
 *   npx tsx scripts/migration/migrate-gsc-history.ts            # dry-run
 *   npx tsx scripts/migration/migrate-gsc-history.ts --apply
 */

// On réutilise le singleton Prisma du bridge (src/db/prisma.ts) : ça résout
// `@prisma/client` depuis veridian-bridge/node_modules sans ajouter de
// dépendance ni de node_modules dans scripts/. Lancer ces scripts via
// `npx tsx` (le bridge fournit tsx) — cf. README.md.
import { getPrisma } from "../../veridian-bridge/src/db/prisma.js";
import { CLIENTS_TO_MIGRATE } from "./lib/clients.js";
import { readDumpFile, filterBySiteId } from "./lib/dump-io.js";
import {
  mapGscProperty,
  mapGscDaily,
  type LegacyGscProperty,
  type LegacyGscDaily,
} from "./lib/mapping.js";
import { parseFlags, makeLogger, modeBanner } from "./lib/cli.js";

const log = makeLogger("migrate-gsc-history");

/** Row legacy `analytics.Site` (sous-ensemble utile à la résolution). */
interface LegacySite {
  id: string;
  siteKey: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error(`variable d'environnement requise manquante : ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  log.info(modeBanner(flags));

  const legacySites = readDumpFile<LegacySite>(requireEnv("LEGACY_SITE_DUMP"));
  const gscProps = readDumpFile<LegacyGscProperty>(
    requireEnv("GSC_PROPERTY_DUMP"),
  );
  const gscDaily = readDumpFile<LegacyGscDaily>(requireEnv("GSC_DAILY_DUMP"));
  log.info(
    `dumps chargés : ${legacySites.length} sites, ${gscProps.length} propriétés, ` +
      `${gscDaily.length} rows daily`,
  );

  const prisma = getPrisma();
  let totalProps = 0;
  let totalDaily = 0;

  try {
    for (const client of CLIENTS_TO_MIGRATE) {
      // 1. Résout le Site bridge (créé par migrate-existing-tenants.ts).
      const bridgeSite = await prisma.site.findUnique({
        where: { siteKey: client.legacySiteKey },
      });
      if (!bridgeSite) {
        log.warn(
          `${client.slug} : Site bridge introuvable pour siteKey ` +
            `${client.legacySiteKey} — lancer migrate-existing-tenants.ts d'abord. Skip.`,
        );
        continue;
      }

      // 2. Résout le siteId legacy via le siteKey.
      const legacySite = legacySites.find(
        (s) => s.siteKey === client.legacySiteKey,
      );
      if (!legacySite) {
        log.warn(
          `${client.slug} : aucune row legacy.Site avec siteKey ` +
            `${client.legacySiteKey} dans le dump. Skip.`,
        );
        continue;
      }

      // 3. GscProperty du site.
      const clientProps = filterBySiteId(gscProps, legacySite.id);
      for (const legacyProp of clientProps) {
        const mapped = mapGscProperty(legacyProp, bridgeSite.tenantId);
        if (flags.dryRun) {
          log.info(
            `  [dry-run] ${client.slug} GscProperty ${mapped.siteUrl} ` +
              `(${mapped.type})`,
          );
        } else {
          await prisma.gscProperty.upsert({
            where: {
              tenantId_siteUrl: {
                tenantId: mapped.tenantId,
                siteUrl: mapped.siteUrl,
              },
            },
            update: {
              type: mapped.type,
              ownershipState: mapped.ownershipState,
              lastSyncAt: mapped.lastSyncAt,
            },
            create: {
              id: mapped.id,
              tenantId: mapped.tenantId,
              siteUrl: mapped.siteUrl,
              type: mapped.type,
              ownershipState: mapped.ownershipState,
              lastSyncAt: mapped.lastSyncAt,
            },
          });
        }
        totalProps++;

        // 4. GscDaily rattachées à cette propriété.
        //    Les daily legacy sont liées au siteId legacy ; on les rattache
        //    à la GscProperty bridge (id conservé = legacyProp.id).
        const clientDaily = filterBySiteId(gscDaily, legacySite.id);
        let limited = clientDaily;
        if (flags.limit) limited = clientDaily.slice(0, flags.limit);

        for (const legacyRow of limited) {
          const mappedDaily = mapGscDaily(legacyRow, mapped.id);
          if (flags.dryRun) {
            if (flags.verbose) {
              log.info(
                `  [dry-run] ${client.slug} GscDaily ${mappedDaily.date
                  .toISOString()
                  .slice(0, 10)} q="${mappedDaily.query}"`,
              );
            }
          } else {
            await prisma.gscDaily.upsert({
              where: {
                gscPropertyId_date_query_page_country_device_searchType: {
                  gscPropertyId: mappedDaily.gscPropertyId,
                  date: mappedDaily.date,
                  query: mappedDaily.query,
                  page: mappedDaily.page,
                  country: mappedDaily.country,
                  device: mappedDaily.device,
                  searchType: mappedDaily.searchType,
                },
              },
              update: {
                impressions: mappedDaily.impressions,
                clicks: mappedDaily.clicks,
                position: mappedDaily.position,
                ctr: mappedDaily.ctr,
              },
              create: mappedDaily,
            });
          }
          totalDaily++;
        }
        log.ok(
          `  ${client.slug} : propriété ${mapped.siteUrl} → ` +
            `${limited.length} rows daily ${flags.dryRun ? "(dry-run)" : "importées"}`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  log.info(
    `${flags.dryRun ? "Dry-run" : "Migration"} GSC terminé : ` +
      `${totalProps} propriété(s), ${totalDaily} row(s) daily.`,
  );
  if (flags.dryRun) log.info("Aucune écriture. Relancer avec --apply.");
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
