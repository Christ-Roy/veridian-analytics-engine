/**
 * FakePrismaClient extension pour les models Forms (B1).
 *
 * Étend `FakePrismaClient` avec les opérations utilisées par
 * `src/forms/*` : site, formSchema, formSubmission, lead, leadSession.
 *
 * Pourquoi un fichier séparé de fake-prisma.ts ?
 *   - Garde fake-prisma.ts (A4) inchangé → aucun risque pour les tests GSC
 *   - Coupe la responsabilité (forms vs GSC) — chaque ticket porte son fake
 *
 * Pattern : duck-typed PrismaClient (cast `as unknown as PrismaClient` côté
 * tests). On implémente UNIQUEMENT les méthodes appelées par forms/*.
 */

import { randomUUID } from "node:crypto";
import { FakePrismaClient, type FakeTenant } from "./fake-prisma.js";

export interface FakeSite {
  id: string;
  tenantId: string;
  siteKey: string;
  domain: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeFormSchema {
  id: string;
  siteId: string;
  formSlug: string;
  name: string;
  fields: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeFormSubmission {
  id: string;
  siteId: string;
  formSchemaId: string | null;
  formSlug: string;
  data: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  pageUrl: string | null;
  visitorId: string | null;
  sessionId: string | null;
  leadId: string | null;
  createdAt: Date;
}

export interface FakeLead {
  id: string;
  siteId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  metadata: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  submissionsCount: number;
}

export interface FakeLeadSession {
  id: string;
  leadId: string;
  visitorId: string | null;
  sessionId: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  startedAt: Date;
  endedAt: Date | null;
  pageviewCount: number;
}

/**
 * Étend `FakePrismaClient` avec les models forms. Hérite des tables A4
 * (tenants, gscProperties, gscDailies) — utile pour les tests qui
 * touchent les deux features.
 */
export class FakePrismaClientWithForms extends FakePrismaClient {
  sites: FakeSite[] = [];
  formSchemas: FakeFormSchema[] = [];
  formSubmissions: FakeFormSubmission[] = [];
  leads: FakeLead[] = [];
  leadSessions: FakeLeadSession[] = [];

  // ─── Site ────────────────────────────────────────────────────────────
  site = {
    findUnique: async (args: {
      where: { id?: string; siteKey?: string };
      include?: { tenant?: boolean };
    }): Promise<(FakeSite & { tenant?: FakeTenant }) | null> => {
      const s = this.sites.find(
        (x) =>
          (args.where.id && x.id === args.where.id) ||
          (args.where.siteKey && x.siteKey === args.where.siteKey),
      );
      if (!s) return null;
      if (args.include?.tenant) {
        const tenant = this.tenants.find((t) => t.id === s.tenantId);
        if (!tenant) {
          throw new Error(`tenant ${s.tenantId} not found for site ${s.id}`);
        }
        return { ...s, tenant };
      }
      return s;
    },
    create: async (args: {
      data: Partial<FakeSite> & { tenantId: string; siteKey: string };
    }): Promise<FakeSite> => {
      const now = new Date();
      const s: FakeSite = {
        id: args.data.id ?? `site_${randomUUID().slice(0, 8)}`,
        tenantId: args.data.tenantId,
        siteKey: args.data.siteKey,
        domain: args.data.domain ?? "example.com",
        name: args.data.name ?? "Test Site",
        createdAt: now,
        updatedAt: now,
      };
      this.sites.push(s);
      return s;
    },
  };

  // ─── FormSchema ──────────────────────────────────────────────────────
  formSchema = {
    upsert: async (args: {
      where: { siteId_formSlug: { siteId: string; formSlug: string } };
      update: Partial<FakeFormSchema>;
      create: Partial<FakeFormSchema> & {
        siteId: string;
        formSlug: string;
        name: string;
      };
    }): Promise<FakeFormSchema> => {
      const existing = this.formSchemas.find(
        (x) =>
          x.siteId === args.where.siteId_formSlug.siteId &&
          x.formSlug === args.where.siteId_formSlug.formSlug,
      );
      const now = new Date();
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: now });
        return existing;
      }
      const fs: FakeFormSchema = {
        id: `fs_${randomUUID().slice(0, 8)}`,
        siteId: args.create.siteId,
        formSlug: args.create.formSlug,
        name: args.create.name,
        fields: args.create.fields ?? [],
        createdAt: now,
        updatedAt: now,
      };
      this.formSchemas.push(fs);
      return fs;
    },
    findUnique: async (args: {
      where: {
        id?: string;
        siteId_formSlug?: { siteId: string; formSlug: string };
      };
    }): Promise<FakeFormSchema | null> => {
      const fs = this.formSchemas.find((x) => {
        if (args.where.id) return x.id === args.where.id;
        if (args.where.siteId_formSlug)
          return (
            x.siteId === args.where.siteId_formSlug.siteId &&
            x.formSlug === args.where.siteId_formSlug.formSlug
          );
        return false;
      });
      return fs ?? null;
    },
  };

  // ─── FormSubmission ──────────────────────────────────────────────────
  formSubmission = {
    create: async (args: {
      data: Partial<FakeFormSubmission> & {
        siteId: string;
        formSlug: string;
        data: unknown;
      };
    }): Promise<FakeFormSubmission> => {
      const s: FakeFormSubmission = {
        id: `sub_${randomUUID().slice(0, 8)}`,
        siteId: args.data.siteId,
        formSchemaId: args.data.formSchemaId ?? null,
        formSlug: args.data.formSlug,
        data: args.data.data,
        ipAddress: args.data.ipAddress ?? null,
        userAgent: args.data.userAgent ?? null,
        pageUrl: args.data.pageUrl ?? null,
        visitorId: args.data.visitorId ?? null,
        sessionId: args.data.sessionId ?? null,
        leadId: args.data.leadId ?? null,
        createdAt: new Date(),
      };
      this.formSubmissions.push(s);
      return s;
    },
    findMany: async (args: {
      where?: {
        siteId?: { in: string[] } | string;
        formSlug?: string;
        createdAt?: { gte?: Date; lte?: Date };
      };
      orderBy?: { createdAt?: "asc" | "desc" };
      take?: number;
      cursor?: { id: string };
      skip?: number;
      include?: { lead?: { select?: { email?: boolean } } };
    }): Promise<Array<FakeFormSubmission & { lead?: { email: string | null } | null }>> => {
      let res = [...this.formSubmissions];
      if (args.where?.siteId) {
        if (typeof args.where.siteId === "string") {
          res = res.filter((s) => s.siteId === args.where!.siteId);
        } else {
          const ids = new Set(args.where.siteId.in);
          res = res.filter((s) => ids.has(s.siteId));
        }
      }
      if (args.where?.formSlug) {
        res = res.filter((s) => s.formSlug === args.where!.formSlug);
      }
      if (args.where?.createdAt?.gte) {
        res = res.filter((s) => s.createdAt >= args.where!.createdAt!.gte!);
      }
      if (args.where?.createdAt?.lte) {
        res = res.filter((s) => s.createdAt <= args.where!.createdAt!.lte!);
      }
      if (args.orderBy?.createdAt === "desc") {
        res.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (args.orderBy?.createdAt === "asc") {
        res.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (args.cursor?.id) {
        const idx = res.findIndex((s) => s.id === args.cursor!.id);
        if (idx >= 0) {
          res = res.slice(idx + (args.skip ?? 0));
        }
      }
      if (args.take) res = res.slice(0, args.take);

      if (args.include?.lead) {
        return res.map((s) => {
          const lead = s.leadId
            ? this.leads.find((l) => l.id === s.leadId) ?? null
            : null;
          return {
            ...s,
            lead: lead ? { email: lead.email } : null,
          };
        });
      }
      return res;
    },
  };

  // ─── Lead ────────────────────────────────────────────────────────────
  lead = {
    findUnique: async (args: {
      where: {
        id?: string;
        siteId_email?: { siteId: string; email: string };
      };
      include?: {
        submissions?: { orderBy?: unknown; take?: number; select?: unknown };
        sessions?: { orderBy?: unknown; take?: number; select?: unknown };
      };
    }): Promise<
      | (FakeLead & {
          submissions?: FakeFormSubmission[];
          sessions?: FakeLeadSession[];
        })
      | null
    > => {
      const l = this.leads.find((x) => {
        if (args.where.id) return x.id === args.where.id;
        if (args.where.siteId_email)
          return (
            x.siteId === args.where.siteId_email.siteId &&
            x.email === args.where.siteId_email.email
          );
        return false;
      });
      if (!l) return null;
      const out: FakeLead & {
        submissions?: FakeFormSubmission[];
        sessions?: FakeLeadSession[];
      } = { ...l };
      if (args.include?.submissions) {
        const subs = this.formSubmissions
          .filter((s) => s.leadId === l.id)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const take = (args.include.submissions as { take?: number }).take ?? 200;
        out.submissions = subs.slice(0, take);
      }
      if (args.include?.sessions) {
        const sess = this.leadSessions
          .filter((s) => s.leadId === l.id)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        const take = (args.include.sessions as { take?: number }).take ?? 200;
        out.sessions = sess.slice(0, take);
      }
      return out;
    },
    create: async (args: {
      data: Partial<FakeLead> & { siteId: string };
    }): Promise<FakeLead> => {
      const now = new Date();
      const l: FakeLead = {
        id: `lead_${randomUUID().slice(0, 8)}`,
        siteId: args.data.siteId,
        email: args.data.email ?? null,
        phone: args.data.phone ?? null,
        name: args.data.name ?? null,
        metadata: args.data.metadata ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        submissionsCount: args.data.submissionsCount ?? 1,
      };
      this.leads.push(l);
      return l;
    },
    update: async (args: {
      where: { id: string };
      data: {
        lastSeenAt?: Date;
        submissionsCount?: { increment: number } | number;
        phone?: string | null;
        name?: string | null;
      };
    }): Promise<FakeLead> => {
      const l = this.leads.find((x) => x.id === args.where.id);
      if (!l) throw new Error(`lead ${args.where.id} not found`);
      if (args.data.lastSeenAt) l.lastSeenAt = args.data.lastSeenAt;
      if (args.data.submissionsCount !== undefined) {
        if (
          typeof args.data.submissionsCount === "object" &&
          "increment" in args.data.submissionsCount
        ) {
          l.submissionsCount += args.data.submissionsCount.increment;
        } else {
          l.submissionsCount = args.data.submissionsCount;
        }
      }
      if (args.data.phone !== undefined) l.phone = args.data.phone;
      if (args.data.name !== undefined) l.name = args.data.name;
      return l;
    },
  };

  // ─── LeadSession ─────────────────────────────────────────────────────
  leadSession = {
    findFirst: async (args: {
      where: { leadId: string; visitorId?: string };
    }): Promise<FakeLeadSession | null> => {
      return (
        this.leadSessions.find(
          (s) =>
            s.leadId === args.where.leadId &&
            (args.where.visitorId === undefined ||
              s.visitorId === args.where.visitorId),
        ) ?? null
      );
    },
    create: async (args: {
      data: Partial<FakeLeadSession> & { leadId: string };
    }): Promise<FakeLeadSession> => {
      const now = new Date();
      const s: FakeLeadSession = {
        id: `ls_${randomUUID().slice(0, 8)}`,
        leadId: args.data.leadId,
        visitorId: args.data.visitorId ?? null,
        sessionId: args.data.sessionId ?? null,
        source: args.data.source ?? null,
        medium: args.data.medium ?? null,
        campaign: args.data.campaign ?? null,
        startedAt: now,
        endedAt: args.data.endedAt ?? null,
        pageviewCount: args.data.pageviewCount ?? 1,
      };
      this.leadSessions.push(s);
      return s;
    },
    update: async (args: {
      where: { id: string };
      data: {
        sessionId?: string | null;
        pageviewCount?: { increment: number } | number;
        source?: string | null;
        medium?: string | null;
        campaign?: string | null;
      };
    }): Promise<FakeLeadSession> => {
      const s = this.leadSessions.find((x) => x.id === args.where.id);
      if (!s) throw new Error(`leadSession ${args.where.id} not found`);
      if (args.data.sessionId !== undefined) s.sessionId = args.data.sessionId;
      if (args.data.pageviewCount !== undefined) {
        if (
          typeof args.data.pageviewCount === "object" &&
          "increment" in args.data.pageviewCount
        ) {
          s.pageviewCount += args.data.pageviewCount.increment;
        } else {
          s.pageviewCount = args.data.pageviewCount;
        }
      }
      if (args.data.source !== undefined) s.source = args.data.source;
      if (args.data.medium !== undefined) s.medium = args.data.medium;
      if (args.data.campaign !== undefined) s.campaign = args.data.campaign;
      return s;
    },
  };

  constructor() {
    super();
    // Wrap tenant.findUnique pour ajouter le support de `include.sites`.
    // On capture l'impl parente, puis on installe une nouvelle qui délègue
    // pour les cas hors-sites.
    const parentFindUnique = this.tenant.findUnique.bind(this.tenant);
    this.tenant.findUnique = (async (args: {
      where: { id?: string; workspaceId?: string };
      include?: {
        gscProperties?: unknown;
        sites?: { select?: { id?: boolean } };
      };
    }) => {
      if (args.include?.sites) {
        const t = this.tenants.find(
          (x) =>
            (args.where.id && x.id === args.where.id) ||
            (args.where.workspaceId &&
              x.workspaceId === args.where.workspaceId),
        );
        if (!t) return null;
        const sites = this.sites
          .filter((s) => s.tenantId === t.id)
          .map((s) => ({ id: s.id }));
        return { ...t, sites } as FakeTenant & {
          sites: Array<{ id: string }>;
        };
      }
      return parentFindUnique(args) as unknown;
    }) as typeof this.tenant.findUnique;
  }
}
