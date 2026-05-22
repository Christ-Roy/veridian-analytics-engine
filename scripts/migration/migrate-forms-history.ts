#!/usr/bin/env -S npx tsx
/**
 * migrate-forms-history.ts — import de l'historique formulaires/leads.
 *
 * Optionnel (ticket D2 §6) : conserve les FormSubmission + Lead + LeadSession
 * legacy côté bridge pour ne pas perdre les leads commerciaux historiques.
 *
 * Ordre d'import IMPÉRATIF (contraintes FK) :
 *   1. FormSchema   (référencé par FormSubmission.formSchemaId)
 *   2. Lead         (référencé par FormSubmission.leadId, LeadSession.leadId)
 *   3. FormSubmission
 *   4. LeadSession
 *
 * IDEMPOTENT :
 *   - FormSchema : upsert sur @@unique (siteId, formSlug)
 *   - Lead       : upsert sur @@unique (siteId, email) ; les leads sans email
 *     sont upsertés par id (createMany skipDuplicates).
 *   - FormSubmission / LeadSession : upsert par id (PK).
 *   - `submissionsCount` du Lead est RECALCULÉ depuis le nombre de
 *     FormSubmission portées (legacy n'a pas ce compteur).
 *
 * DRY-RUN par défaut.
 *
 * Variables d'environnement :
 *   BRIDGE_DATABASE_URL    — Postgres du bridge (cible)
 *   LEGACY_SITE_DUMP       — dump JSON analytics.Site
 *   FORM_SCHEMA_DUMP       — dump JSON analytics.FormSchema
 *   LEAD_DUMP              — dump JSON analytics.Lead
 *   FORM_SUBMISSION_DUMP   — dump JSON analytics.FormSubmission
 *   LEAD_SESSION_DUMP      — dump JSON analytics.LeadSession
 *
 * Usage :
 *   npx tsx scripts/migration/migrate-forms-history.ts            # dry-run
 *   npx tsx scripts/migration/migrate-forms-history.ts --apply
 */

// Réutilise le singleton Prisma du bridge — résout `@prisma/client` depuis
// veridian-bridge/node_modules sans dépendance ajoutée dans scripts/.
import { getPrisma } from "../../veridian-bridge/src/db/prisma.js";
import { CLIENTS_TO_MIGRATE } from "./lib/clients.js";
import { readDumpFile, filterBySiteId } from "./lib/dump-io.js";
import {
  mapFormSchema,
  mapLead,
  mapFormSubmission,
  mapLeadSession,
  type LegacyFormSchema,
  type LegacyLead,
  type LegacyFormSubmission,
  type LegacyLeadSession,
} from "./lib/mapping.js";
import { countSubmissionsPerLead } from "./lib/forms-stats.js";
import { parseFlags, makeLogger, modeBanner } from "./lib/cli.js";

const log = makeLogger("migrate-forms-history");

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
  const schemas = readDumpFile<LegacyFormSchema>(requireEnv("FORM_SCHEMA_DUMP"));
  const leads = readDumpFile<LegacyLead>(requireEnv("LEAD_DUMP"));
  const submissions = readDumpFile<LegacyFormSubmission>(
    requireEnv("FORM_SUBMISSION_DUMP"),
  );
  const sessions = readDumpFile<LegacyLeadSession>(
    requireEnv("LEAD_SESSION_DUMP"),
  );
  log.info(
    `dumps chargés : ${schemas.length} schemas, ${leads.length} leads, ` +
      `${submissions.length} submissions, ${sessions.length} sessions`,
  );

  const prisma = getPrisma();
  const totals = { schemas: 0, leads: 0, submissions: 0, sessions: 0 };

  try {
    for (const client of CLIENTS_TO_MIGRATE) {
      const bridgeSite = await prisma.site.findUnique({
        where: { siteKey: client.legacySiteKey },
      });
      if (!bridgeSite) {
        log.warn(
          `${client.slug} : Site bridge introuvable — lancer ` +
            `migrate-existing-tenants.ts d'abord. Skip.`,
        );
        continue;
      }
      const legacySite = legacySites.find(
        (s) => s.siteKey === client.legacySiteKey,
      );
      if (!legacySite) {
        log.warn(`${client.slug} : legacy.Site absent du dump. Skip.`);
        continue;
      }

      const clientSchemas = filterBySiteId(schemas, legacySite.id);
      const clientLeads = filterBySiteId(leads, legacySite.id);
      const clientSubs = filterBySiteId(submissions, legacySite.id);
      // LeadSession legacy a un siteId → filtre direct.
      const clientSessions = filterBySiteId(sessions, legacySite.id);

      // submissionsCount recalculé depuis les submissions réelles.
      const subCountByLead = countSubmissionsPerLead(clientSubs);

      // ─── 1. FormSchema ───────────────────────────────────────────────
      for (const ls of clientSchemas) {
        const mapped = mapFormSchema(ls, bridgeSite.id);
        if (flags.dryRun) {
          log.info(`  [dry-run] ${client.slug} FormSchema ${mapped.formSlug}`);
        } else {
          await prisma.formSchema.upsert({
            where: {
              siteId_formSlug: {
                siteId: mapped.siteId,
                formSlug: mapped.formSlug,
              },
            },
            update: { name: mapped.name },
            create: {
              id: mapped.id,
              siteId: mapped.siteId,
              formSlug: mapped.formSlug,
              name: mapped.name,
              fields: mapped.fields as object,
            },
          });
        }
        totals.schemas++;
      }

      // Map formSlug → bridge FormSchema id (pour rattacher les submissions).
      const schemaIdBySlug = new Map<string, string>();
      if (!flags.dryRun) {
        const bridgeSchemas = await prisma.formSchema.findMany({
          where: { siteId: bridgeSite.id },
        });
        for (const s of bridgeSchemas) schemaIdBySlug.set(s.formSlug, s.id);
      }

      // ─── 2. Lead ─────────────────────────────────────────────────────
      for (const ll of clientLeads) {
        const mapped = mapLead(ll, bridgeSite.id);
        const submissionsCount = subCountByLead.get(ll.id) ?? 1;
        if (flags.dryRun) {
          log.info(
            `  [dry-run] ${client.slug} Lead ${mapped.email ?? "(no-email)"} ` +
              `submissionsCount=${submissionsCount}`,
          );
        } else if (mapped.email) {
          // Dédup par (siteId, email) — contrainte @@unique du bridge.
          await prisma.lead.upsert({
            where: {
              siteId_email: { siteId: mapped.siteId, email: mapped.email },
            },
            update: {
              phone: mapped.phone,
              name: mapped.name,
              lastSeenAt: mapped.lastSeenAt,
              submissionsCount,
            },
            create: {
              id: mapped.id,
              siteId: mapped.siteId,
              email: mapped.email,
              phone: mapped.phone,
              name: mapped.name,
              firstSeenAt: mapped.firstSeenAt,
              lastSeenAt: mapped.lastSeenAt,
              submissionsCount,
            },
          });
        } else {
          // Lead sans email : pas de contrainte unique → upsert par id.
          await prisma.lead.upsert({
            where: { id: mapped.id },
            update: {
              phone: mapped.phone,
              name: mapped.name,
              lastSeenAt: mapped.lastSeenAt,
              submissionsCount,
            },
            create: {
              id: mapped.id,
              siteId: mapped.siteId,
              email: null,
              phone: mapped.phone,
              name: mapped.name,
              firstSeenAt: mapped.firstSeenAt,
              lastSeenAt: mapped.lastSeenAt,
              submissionsCount,
            },
          });
        }
        totals.leads++;
      }

      // legacy leadId → bridge leadId est une identité (id conservé).
      // ─── 3. FormSubmission ───────────────────────────────────────────
      for (const lsub of clientSubs) {
        const schemaId = flags.dryRun
          ? null
          : schemaIdBySlug.get(lsub.formName) ?? null;
        const mapped = mapFormSubmission(lsub, bridgeSite.id, schemaId);
        if (flags.dryRun) {
          if (flags.verbose) {
            log.info(
              `  [dry-run] ${client.slug} FormSubmission ${mapped.formSlug} ` +
                `${mapped.createdAt.toISOString()}`,
            );
          }
        } else {
          await prisma.formSubmission.upsert({
            where: { id: mapped.id },
            update: {},
            create: {
              id: mapped.id,
              siteId: mapped.siteId,
              formSchemaId: mapped.formSchemaId,
              formSlug: mapped.formSlug,
              data: mapped.data as object,
              pageUrl: mapped.pageUrl,
              visitorId: mapped.visitorId,
              sessionId: mapped.sessionId,
              leadId: mapped.leadId,
              createdAt: mapped.createdAt,
            },
          });
        }
        totals.submissions++;
      }

      // ─── 4. LeadSession ──────────────────────────────────────────────
      for (const lses of clientSessions) {
        const mapped = mapLeadSession(lses);
        if (flags.dryRun) {
          if (flags.verbose) {
            log.info(
              `  [dry-run] ${client.slug} LeadSession ${mapped.sessionId}`,
            );
          }
        } else {
          await prisma.leadSession.upsert({
            where: { id: mapped.id },
            update: { pageviewCount: mapped.pageviewCount },
            create: {
              id: mapped.id,
              leadId: mapped.leadId,
              visitorId: mapped.visitorId,
              sessionId: mapped.sessionId,
              startedAt: mapped.startedAt,
              endedAt: mapped.endedAt,
              pageviewCount: mapped.pageviewCount,
            },
          });
        }
        totals.sessions++;
      }

      log.ok(
        `  ${client.slug} : ${clientSchemas.length} schemas, ` +
          `${clientLeads.length} leads, ${clientSubs.length} submissions, ` +
          `${clientSessions.length} sessions ${flags.dryRun ? "(dry-run)" : "OK"}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  log.info(
    `${flags.dryRun ? "Dry-run" : "Migration"} Forms terminé : ` +
      `${totals.schemas} schemas, ${totals.leads} leads, ` +
      `${totals.submissions} submissions, ${totals.sessions} sessions.`,
  );
  if (flags.dryRun) log.info("Aucune écriture. Relancer avec --apply.");
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
