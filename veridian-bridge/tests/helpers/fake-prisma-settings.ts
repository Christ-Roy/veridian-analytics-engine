/**
 * FakePrismaClient extension pour les models Settings/Credentials (U8).
 *
 * Étend `FakePrismaClientWithSites` (qui a tenant/site/gscProperty) avec
 * les models propres à U8 : `tenantCredential`, `tenantSettings`, et un
 * `site.findMany` (le parent n'expose que `site.findUnique/create`).
 *
 * Note 2026-05-23 : on hérite désormais de `FakePrismaClientWithSites` au
 * lieu de l'ancien `FakePrismaClientWithForms` (module Forms retiré, cf
 * cleanup-veridian-scope).
 *
 * Pattern : duck-typed PrismaClient, cast `as unknown as PrismaClient` côté
 * tests. On implémente UNIQUEMENT ce qui est appelé par `src/settings/*` et
 * `src/credentials/*`.
 *
 * ⚠️ Ces fakes ne prouvent RIEN sur le vrai Postgres (contraintes @@unique,
 * cascade FK) — c'est le rôle des `*.integration.test.ts`. Ici on valide la
 * logique métier (chiffrement, masquage, validation, agrégation de vue).
 */

import { randomUUID } from "node:crypto";
import {
  FakePrismaClientWithSites,
  type FakeSite,
} from "./fake-prisma-with-sites.js";

export interface FakeTenantCredential {
  id: string;
  tenantId: string;
  kind: string;
  encryptedData: unknown;
  status: string;
  lastSyncAt: Date | null;
  lastTestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTenantSettings {
  id: string;
  tenantId: string;
  notifyNewLead: boolean;
  notifyWeeklyReport: boolean;
  notifyEmail: string | null;
  pushAdminEnabled: boolean;
  visitorIdEnabled: boolean;
  cookieConsentEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class FakePrismaClientWithSettings extends FakePrismaClientWithSites {
  tenantCredentials: FakeTenantCredential[] = [];
  tenantSettingsRows: FakeTenantSettings[] = [];

  constructor() {
    super();
    // `site.findMany` n'existe pas dans le parent — on l'ajoute ici.
    const sites = this.sites;
    (this.site as Record<string, unknown>).findMany = async (args?: {
      where?: { tenantId?: string };
    }): Promise<FakeSite[]> => {
      let res = [...sites];
      if (args?.where?.tenantId) {
        res = res.filter((s) => s.tenantId === args.where!.tenantId);
      }
      return res;
    };
  }

  // ─── TenantCredential ──────────────────────────────────────────────────
  tenantCredential = {
    findUnique: async (args: {
      where: {
        id?: string;
        tenantId_kind?: { tenantId: string; kind: string };
      };
    }): Promise<FakeTenantCredential | null> => {
      const c = this.tenantCredentials.find((x) => {
        if (args.where.id) return x.id === args.where.id;
        if (args.where.tenantId_kind) {
          return (
            x.tenantId === args.where.tenantId_kind.tenantId &&
            x.kind === args.where.tenantId_kind.kind
          );
        }
        return false;
      });
      return c ?? null;
    },

    findMany: async (args?: {
      where?: { tenantId?: string };
      orderBy?: unknown;
    }): Promise<FakeTenantCredential[]> => {
      let res = [...this.tenantCredentials];
      if (args?.where?.tenantId) {
        res = res.filter((c) => c.tenantId === args.where!.tenantId);
      }
      return res.sort((a, b) => a.kind.localeCompare(b.kind));
    },

    upsert: async (args: {
      where: { tenantId_kind: { tenantId: string; kind: string } };
      update: Partial<FakeTenantCredential>;
      create: Partial<FakeTenantCredential> & {
        tenantId: string;
        kind: string;
        encryptedData: unknown;
      };
    }): Promise<FakeTenantCredential> => {
      const existing = this.tenantCredentials.find(
        (x) =>
          x.tenantId === args.where.tenantId_kind.tenantId &&
          x.kind === args.where.tenantId_kind.kind,
      );
      const now = new Date();
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: now });
        return existing;
      }
      const c: FakeTenantCredential = {
        id: `cred_${randomUUID().slice(0, 8)}`,
        tenantId: args.create.tenantId,
        kind: args.create.kind,
        encryptedData: args.create.encryptedData,
        status: args.create.status ?? "untested",
        lastSyncAt: args.create.lastSyncAt ?? null,
        lastTestedAt: args.create.lastTestedAt ?? null,
        lastError: args.create.lastError ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.tenantCredentials.push(c);
      return c;
    },

    update: async (args: {
      where: { id: string };
      data: Partial<FakeTenantCredential>;
    }): Promise<FakeTenantCredential> => {
      const c = this.tenantCredentials.find((x) => x.id === args.where.id);
      if (!c) throw new Error("tenantCredential not found");
      Object.assign(c, args.data, { updatedAt: new Date() });
      return c;
    },

    delete: async (args: {
      where: { id: string };
    }): Promise<FakeTenantCredential> => {
      const idx = this.tenantCredentials.findIndex(
        (x) => x.id === args.where.id,
      );
      if (idx === -1) throw new Error("tenantCredential not found");
      const [removed] = this.tenantCredentials.splice(idx, 1);
      return removed;
    },
  };

  // ─── TenantSettings ────────────────────────────────────────────────────
  tenantSettings = {
    findUnique: async (args: {
      where: { tenantId?: string; id?: string };
    }): Promise<FakeTenantSettings | null> => {
      const s = this.tenantSettingsRows.find(
        (x) =>
          (args.where.tenantId && x.tenantId === args.where.tenantId) ||
          (args.where.id && x.id === args.where.id),
      );
      return s ?? null;
    },

    upsert: async (args: {
      where: { tenantId: string };
      update: Partial<FakeTenantSettings>;
      create: Partial<FakeTenantSettings> & { tenantId: string };
    }): Promise<FakeTenantSettings> => {
      const existing = this.tenantSettingsRows.find(
        (x) => x.tenantId === args.where.tenantId,
      );
      const now = new Date();
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: now });
        return existing;
      }
      const s: FakeTenantSettings = {
        id: `set_${randomUUID().slice(0, 8)}`,
        tenantId: args.create.tenantId,
        notifyNewLead: args.create.notifyNewLead ?? true,
        notifyWeeklyReport: args.create.notifyWeeklyReport ?? true,
        notifyEmail: args.create.notifyEmail ?? null,
        pushAdminEnabled: args.create.pushAdminEnabled ?? true,
        visitorIdEnabled: args.create.visitorIdEnabled ?? true,
        cookieConsentEnabled: args.create.cookieConsentEnabled ?? false,
        createdAt: now,
        updatedAt: now,
      };
      this.tenantSettingsRows.push(s);
      return s;
    },
  };
}
