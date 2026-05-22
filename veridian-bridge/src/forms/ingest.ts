/**
 * Ingestion d'une soumission de formulaire (B1).
 *
 * Happy path :
 *   1. Lookup `Site` par siteKey
 *   2. Auto-create `FormSchema` si formSlug inconnu (siteId + formSlug)
 *   3. Sanitize `data` (anti-XSS) + extract email/phone/name
 *   4. Si email présent → upsert `Lead` (dedup par (siteId, email)).
 *      Incrémente `submissionsCount` + bump `lastSeenAt` si déjà existant.
 *   5. Create `FormSubmission` lié au Lead (si email) + FormSchema
 *   6. Upsert `LeadSession` matché par visitorId (ou crée nouveau)
 *   7. Best-effort push event `form_submission` vers staminads
 *
 * Erreurs typées :
 *   - `SiteKeyNotFoundError` (siteKey inconnu ou tenant soft-deleted)
 *
 * La sanitization fait que `data` stocké est safe. Aucun `eval` ni rendu
 * brut côté bridge — le front DOIT aussi échapper à l'affichage.
 */

import type { PrismaClient } from "@prisma/client";
import {
  type IngestFormPayload,
} from "./types.js";
import { extractLeadFields, sanitizePayload } from "./sanitize.js";
import {
  pushFormSubmissionEvent,
  type PushFormEventResult,
} from "./staminads-event.js";

export class SiteKeyNotFoundError extends Error {
  constructor(public readonly siteKey: string) {
    super(`site_key_not_found:${siteKey}`);
    this.name = "SiteKeyNotFoundError";
  }
}

export interface IngestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface IngestDeps {
  prisma: PrismaClient;
  staminadsUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface IngestResult {
  submissionId: string;
  leadId: string | null;
  formSchemaId: string;
  leadCreated: boolean;
  staminads: PushFormEventResult | null;
}

/**
 * Ingest une soumission de formulaire — orchestration complète DB + event.
 */
export async function ingestFormSubmission(
  deps: IngestDeps,
  payload: IngestFormPayload,
  ctx: IngestContext = {},
): Promise<IngestResult> {
  const site = await deps.prisma.site.findUnique({
    where: { siteKey: payload.siteKey },
    include: { tenant: true },
  });
  if (!site || site.tenant.softDeletedAt) {
    throw new SiteKeyNotFoundError(payload.siteKey);
  }

  // 1. Sanitize payload BEFORE storage
  const safeData = sanitizePayload(payload.data) as Record<string, unknown>;
  const { email, phone, name } = extractLeadFields(safeData);

  // 2. Auto-create FormSchema si inconnu (upsert idempotent)
  const formSchema = await deps.prisma.formSchema.upsert({
    where: {
      siteId_formSlug: { siteId: site.id, formSlug: payload.formSlug },
    },
    update: {},
    create: {
      siteId: site.id,
      formSlug: payload.formSlug,
      name: payload.formName ?? payload.formSlug,
      fields: [],
    },
  });

  // 3. Lead upsert (dedup par email)
  let leadId: string | null = null;
  let leadCreated = false;
  if (email) {
    const existing = await deps.prisma.lead.findUnique({
      where: { siteId_email: { siteId: site.id, email } },
    });
    if (existing) {
      const updated = await deps.prisma.lead.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          submissionsCount: { increment: 1 },
          // Si on n'avait pas phone/name avant, on enrichit.
          phone: existing.phone ?? phone,
          name: existing.name ?? name,
        },
      });
      leadId = updated.id;
    } else {
      const created = await deps.prisma.lead.create({
        data: {
          siteId: site.id,
          email,
          phone,
          name,
          submissionsCount: 1,
        },
      });
      leadId = created.id;
      leadCreated = true;
    }
  }

  // 4. FormSubmission (toujours)
  const submission = await deps.prisma.formSubmission.create({
    data: {
      siteId: site.id,
      formSchemaId: formSchema.id,
      formSlug: payload.formSlug,
      data: safeData as object,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      pageUrl: payload.pageUrl ?? null,
      visitorId: payload.visitorId ?? null,
      sessionId: payload.sessionId ?? null,
      leadId,
    },
  });

  // 5. LeadSession upsert (matché par visitorId au sein du lead)
  if (leadId && (payload.visitorId || payload.sessionId)) {
    const existingSession = payload.visitorId
      ? await deps.prisma.leadSession.findFirst({
          where: { leadId, visitorId: payload.visitorId },
        })
      : null;
    if (existingSession) {
      await deps.prisma.leadSession.update({
        where: { id: existingSession.id },
        data: {
          sessionId: payload.sessionId ?? existingSession.sessionId,
          pageviewCount: { increment: 1 },
          // Met à jour la dernière utm vue (utile si conversion en fin de
          // funnel après navigation re-attribuée).
          source: payload.utm?.source ?? existingSession.source,
          medium: payload.utm?.medium ?? existingSession.medium,
          campaign: payload.utm?.campaign ?? existingSession.campaign,
        },
      });
    } else {
      await deps.prisma.leadSession.create({
        data: {
          leadId,
          visitorId: payload.visitorId ?? null,
          sessionId: payload.sessionId ?? null,
          source: payload.utm?.source ?? null,
          medium: payload.utm?.medium ?? null,
          campaign: payload.utm?.campaign ?? null,
          pageviewCount: 1,
        },
      });
    }
  }

  // 6. Best-effort staminads event push (ne casse pas la transaction si fail)
  let staminadsResult: PushFormEventResult | null = null;
  if (deps.staminadsUrl) {
    staminadsResult = await pushFormSubmissionEvent({
      staminadsUrl: deps.staminadsUrl,
      workspaceId: site.tenant.workspaceId,
      sessionId: payload.sessionId ?? `form-${submission.id}`,
      formSlug: payload.formSlug,
      leadId,
      submissionId: submission.id,
      pageUrl: payload.pageUrl ?? null,
      fetchImpl: deps.fetchImpl,
    });
  }

  return {
    submissionId: submission.id,
    leadId,
    formSchemaId: formSchema.id,
    leadCreated,
    staminads: staminadsResult,
  };
}
