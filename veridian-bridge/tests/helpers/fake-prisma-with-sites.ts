/**
 * FakePrismaClient extension pour le model `Site` (multi-domaines).
 *
 * Étend `FakePrismaClient` (qui gère tenant + gscProperty/gscDaily) avec
 * juste `site` + `sites`. Utilisé par `fake-prisma-settings.ts`.
 *
 * Note 2026-05-23 : remplace l'ancien `fake-prisma-forms.ts` qui couvrait
 * en plus formSchema/formSubmission/lead/leadSession — modules retirés du
 * scope cleanup-veridian-scope.
 *
 * Pattern : duck-typed PrismaClient (cast `as unknown as PrismaClient` côté
 * tests). On implémente UNIQUEMENT les méthodes appelées par settings/*.
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

/**
 * Étend `FakePrismaClient` avec le model Site. Hérite des tables A4
 * (tenants, gscProperties, gscDailies) — utile pour les tests qui
 * touchent les deux features.
 */
export class FakePrismaClientWithSites extends FakePrismaClient {
  sites: FakeSite[] = [];

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
}
