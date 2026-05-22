/**
 * Lectures dashboard pour les forms / leads (B1).
 *
 * - `listSubmissions(prisma, workspaceId, filters)` : liste paginée des
 *   FormSubmission pour tous les Sites d'un Tenant.
 * - `getLeadDetails(prisma, leadId)` : Lead + submissions + sessions.
 *
 * Pagination = curseur sur createdAt (decreasing). Permet une UI infinite
 * scroll stable même si de nouveaux items arrivent.
 */

import type { PrismaClient } from "@prisma/client";
import {
  type LeadDetails,
  type ListSubmissionsFilters,
  type ListSubmissionsResult,
  type SubmissionListItem,
} from "./types.js";

export class TenantNotFoundError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`tenant_not_found:${workspaceId}`);
    this.name = "TenantNotFoundError";
  }
}

export class LeadNotFoundError extends Error {
  constructor(public readonly leadId: string) {
    super(`lead_not_found:${leadId}`);
    this.name = "LeadNotFoundError";
  }
}

/**
 * Liste les FormSubmissions d'un tenant. Filtres :
 *   - formSlug : restreindre à un type de form
 *   - since / until : range temporel (ISO datetime)
 *   - limit : max 200 (default 50)
 *   - cursor : id de la dernière submission vue (pour infinite scroll)
 */
export async function listSubmissions(
  prisma: PrismaClient,
  workspaceId: string,
  filters: ListSubmissionsFilters,
): Promise<ListSubmissionsResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { workspaceId },
    include: { sites: { select: { id: true } } },
  });
  if (!tenant) throw new TenantNotFoundError(workspaceId);

  const siteIds = tenant.sites.map((s) => s.id);
  if (siteIds.length === 0) {
    return { items: [], nextCursor: null };
  }

  const where: Record<string, unknown> = {
    siteId: { in: siteIds },
  };
  if (filters.formSlug) where.formSlug = filters.formSlug;
  if (filters.since || filters.until) {
    const range: Record<string, Date> = {};
    if (filters.since) range.gte = new Date(filters.since);
    if (filters.until) range.lte = new Date(filters.until);
    where.createdAt = range;
  }

  // Curseur : `cursor` = id de la dernière row vue. Prisma `cursor` + `skip:1`
  // récupère la page d'après.
  const submissions = await prisma.formSubmission.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: filters.limit + 1, // +1 pour détecter s'il y a une page suivante
    ...(filters.cursor
      ? { cursor: { id: filters.cursor }, skip: 1 }
      : {}),
    include: {
      lead: { select: { email: true } },
    },
  });

  const hasMore = submissions.length > filters.limit;
  const trimmed = hasMore ? submissions.slice(0, filters.limit) : submissions;
  const items: SubmissionListItem[] = trimmed.map((s) => ({
    id: s.id,
    formSlug: s.formSlug,
    createdAt: s.createdAt,
    pageUrl: s.pageUrl,
    leadId: s.leadId,
    leadEmail: s.lead?.email ?? null,
  }));
  return {
    items,
    nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null,
  };
}

/**
 * Renvoie un lead avec toutes ses submissions + sessions (UI lead detail).
 * Limite hard : 200 submissions / 200 sessions max (sinon UI ramasse).
 */
export async function getLeadDetails(
  prisma: PrismaClient,
  leadId: string,
): Promise<LeadDetails> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      submissions: {
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          formSlug: true,
          data: true,
          pageUrl: true,
          createdAt: true,
        },
      },
      sessions: {
        orderBy: { startedAt: "desc" },
        take: 200,
        select: {
          id: true,
          visitorId: true,
          sessionId: true,
          source: true,
          medium: true,
          campaign: true,
          startedAt: true,
          endedAt: true,
          pageviewCount: true,
        },
      },
    },
  });
  if (!lead) throw new LeadNotFoundError(leadId);

  return {
    lead: {
      id: lead.id,
      siteId: lead.siteId,
      email: lead.email,
      phone: lead.phone,
      name: lead.name,
      firstSeenAt: lead.firstSeenAt,
      lastSeenAt: lead.lastSeenAt,
      submissionsCount: lead.submissionsCount,
      metadata: lead.metadata,
    },
    submissions: lead.submissions.map((s) => ({
      id: s.id,
      formSlug: s.formSlug,
      data: s.data,
      pageUrl: s.pageUrl,
      createdAt: s.createdAt,
    })),
    sessions: lead.sessions.map((s) => ({
      id: s.id,
      visitorId: s.visitorId,
      sessionId: s.sessionId,
      source: s.source,
      medium: s.medium,
      campaign: s.campaign,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      pageviewCount: s.pageviewCount,
    })),
  };
}
