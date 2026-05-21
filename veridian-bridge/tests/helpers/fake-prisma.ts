/**
 * FakePrismaClient — implémentation in-memory minimale pour les tests GSC.
 *
 * Couvre les opérations utilisées par src/gsc/* :
 *   - tenant.findUnique / create
 *   - gscProperty.findUnique / findMany / upsert / update / create
 *   - gscDaily.deleteMany / createMany / findMany
 *   - $queryRawUnsafe (implémenté en JS sur la mémoire)
 */

import { randomUUID } from "node:crypto";

export interface FakeTenant {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  hubTenantId: string | null;
  plan: string;
  planSource: string | null;
  status: string;
  apiKey: string | null;
  suspendedAt: Date | null;
  softDeletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeGscProperty {
  id: string;
  tenantId: string;
  siteUrl: string;
  type: string;
  ownershipState: string;
  lastSyncAt: Date | null;
  oauthAccount: object | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeGscDaily {
  id: string;
  gscPropertyId: string;
  date: Date;
  query: string;
  page: string;
  country: string;
  device: string;
  searchType: string;
  impressions: number;
  clicks: number;
  position: number;
  ctr: number;
  createdAt: Date;
}

type QueryRawHandler = (sql: string, params: unknown[]) => unknown[];

export class FakePrismaClient {
  tenants: FakeTenant[] = [];
  gscProperties: FakeGscProperty[] = [];
  gscDailies: FakeGscDaily[] = [];

  private rawHandler: QueryRawHandler | null = null;

  setRawHandler(handler: QueryRawHandler | null): void {
    this.rawHandler = handler;
  }

  tenant = {
    findUnique: async (args: {
      where: { id?: string; workspaceId?: string };
      include?: { gscProperties?: unknown };
    }): Promise<(FakeTenant & { gscProperties?: FakeGscProperty[] }) | null> => {
      const t = this.tenants.find(
        (x) =>
          (args.where.id && x.id === args.where.id) ||
          (args.where.workspaceId && x.workspaceId === args.where.workspaceId),
      );
      if (!t) return null;
      if (args.include?.gscProperties) {
        const opts = args.include.gscProperties as {
          where?: { ownershipState?: string };
          orderBy?: { lastSyncAt?: "desc" | "asc" };
          take?: number;
        };
        let props = this.gscProperties.filter((p) => p.tenantId === t.id);
        if (opts.where?.ownershipState) {
          props = props.filter(
            (p) => p.ownershipState === opts.where!.ownershipState,
          );
        }
        if (opts.orderBy?.lastSyncAt) {
          props = [...props].sort((a, b) => {
            const av = a.lastSyncAt?.getTime() ?? 0;
            const bv = b.lastSyncAt?.getTime() ?? 0;
            return opts.orderBy!.lastSyncAt === "desc" ? bv - av : av - bv;
          });
        }
        if (opts.take) props = props.slice(0, opts.take);
        return { ...t, gscProperties: props };
      }
      return t;
    },
    create: async (args: {
      data: Partial<FakeTenant> & {
        workspaceId: string;
        slug: string;
        name: string;
      };
    }): Promise<FakeTenant> => {
      const now = new Date();
      const t: FakeTenant = {
        id: args.data.id ?? `tenant_${randomUUID().slice(0, 8)}`,
        workspaceId: args.data.workspaceId,
        slug: args.data.slug,
        name: args.data.name,
        hubTenantId: args.data.hubTenantId ?? null,
        plan: args.data.plan ?? "free",
        planSource: args.data.planSource ?? null,
        status: args.data.status ?? "active",
        apiKey: args.data.apiKey ?? null,
        suspendedAt: args.data.suspendedAt ?? null,
        softDeletedAt: args.data.softDeletedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.tenants.push(t);
      return t;
    },
  };

  gscProperty = {
    findUnique: async (args: {
      where: {
        id?: string;
        tenantId_siteUrl?: { tenantId: string; siteUrl: string };
      };
      select?: Partial<Record<keyof FakeGscProperty, boolean>>;
    }): Promise<FakeGscProperty | null> => {
      const p = this.gscProperties.find((x) => {
        if (args.where.id) return x.id === args.where.id;
        if (args.where.tenantId_siteUrl) {
          return (
            x.tenantId === args.where.tenantId_siteUrl.tenantId &&
            x.siteUrl === args.where.tenantId_siteUrl.siteUrl
          );
        }
        return false;
      });
      return p ?? null;
    },
    findMany: async (args: {
      where?: { ownershipState?: string; tenantId?: string };
      select?: Partial<Record<keyof FakeGscProperty, boolean>>;
    }): Promise<Array<Partial<FakeGscProperty>>> => {
      let res = [...this.gscProperties];
      if (args.where?.ownershipState) {
        res = res.filter(
          (p) => p.ownershipState === args.where!.ownershipState,
        );
      }
      if (args.where?.tenantId) {
        res = res.filter((p) => p.tenantId === args.where!.tenantId);
      }
      if (args.select) {
        return res.map((p) => {
          const out: Partial<FakeGscProperty> = {};
          for (const k of Object.keys(args.select!) as Array<
            keyof FakeGscProperty
          >) {
            if (args.select![k])
              (out as Record<string, unknown>)[k] = p[k];
          }
          return out;
        });
      }
      return res;
    },
    upsert: async (args: {
      where: { tenantId_siteUrl: { tenantId: string; siteUrl: string } };
      update: Partial<FakeGscProperty>;
      create: Partial<FakeGscProperty> & {
        tenantId: string;
        siteUrl: string;
        type: string;
      };
    }): Promise<FakeGscProperty> => {
      const existing = this.gscProperties.find(
        (x) =>
          x.tenantId === args.where.tenantId_siteUrl.tenantId &&
          x.siteUrl === args.where.tenantId_siteUrl.siteUrl,
      );
      const now = new Date();
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: now });
        return existing;
      }
      const p: FakeGscProperty = {
        id: `prop_${randomUUID().slice(0, 8)}`,
        tenantId: args.create.tenantId,
        siteUrl: args.create.siteUrl,
        type: args.create.type,
        ownershipState: args.create.ownershipState ?? "pending",
        lastSyncAt: args.create.lastSyncAt ?? null,
        oauthAccount: args.create.oauthAccount ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.gscProperties.push(p);
      return p;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeGscProperty>;
    }): Promise<FakeGscProperty> => {
      const p = this.gscProperties.find((x) => x.id === args.where.id);
      if (!p) throw new Error(`property ${args.where.id} not found`);
      Object.assign(p, args.data, { updatedAt: new Date() });
      return p;
    },
    create: async (args: {
      data: Partial<FakeGscProperty> & {
        tenantId: string;
        siteUrl: string;
        type: string;
      };
    }): Promise<FakeGscProperty> => {
      const now = new Date();
      const p: FakeGscProperty = {
        id: args.data.id ?? `prop_${randomUUID().slice(0, 8)}`,
        tenantId: args.data.tenantId,
        siteUrl: args.data.siteUrl,
        type: args.data.type,
        ownershipState: args.data.ownershipState ?? "pending",
        lastSyncAt: args.data.lastSyncAt ?? null,
        oauthAccount: args.data.oauthAccount ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.gscProperties.push(p);
      return p;
    },
  };

  gscDaily = {
    deleteMany: async (args: {
      where: {
        gscPropertyId?: string;
        searchType?: string;
        date?: { gte?: Date; lte?: Date };
      };
    }): Promise<{ count: number }> => {
      const before = this.gscDailies.length;
      this.gscDailies = this.gscDailies.filter((d) => {
        if (
          args.where.gscPropertyId &&
          d.gscPropertyId !== args.where.gscPropertyId
        )
          return true;
        if (args.where.searchType && d.searchType !== args.where.searchType)
          return true;
        if (args.where.date?.gte && d.date < args.where.date.gte) return true;
        if (args.where.date?.lte && d.date > args.where.date.lte) return true;
        return false;
      });
      return { count: before - this.gscDailies.length };
    },
    createMany: async (args: {
      data: Array<Omit<FakeGscDaily, "id" | "createdAt">>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of args.data) {
        const dup = this.gscDailies.find(
          (d) =>
            d.gscPropertyId === row.gscPropertyId &&
            d.date.getTime() === row.date.getTime() &&
            d.query === row.query &&
            d.page === row.page &&
            d.country === row.country &&
            d.device === row.device &&
            d.searchType === row.searchType,
        );
        if (dup) {
          if (args.skipDuplicates) continue;
          throw new Error("unique constraint violation");
        }
        this.gscDailies.push({
          ...row,
          id: `daily_${randomUUID().slice(0, 8)}`,
          createdAt: new Date(),
        });
        count++;
      }
      return { count };
    },
    findMany: async (args?: {
      where?: { gscPropertyId?: string };
    }): Promise<FakeGscDaily[]> => {
      if (args?.where?.gscPropertyId) {
        return this.gscDailies.filter(
          (d) => d.gscPropertyId === args.where!.gscPropertyId,
        );
      }
      return [...this.gscDailies];
    },
  };

  $queryRawUnsafe = async (
    sql: string,
    ...params: unknown[]
  ): Promise<unknown[]> => {
    if (this.rawHandler) {
      return this.rawHandler(sql, params);
    }
    return computeFromMemory(this.gscDailies, sql, params);
  };
}

/**
 * Implémentation naïve qui exécute en JS l'équivalent d'un SELECT totals
 * ou SELECT GROUP BY. Suffisant pour les tests query.ts.
 */
function computeFromMemory(
  rows: FakeGscDaily[],
  sql: string,
  params: unknown[],
): unknown[] {
  const propertyId = params[0] as string;
  const start = params[1] as Date;
  const end = params[2] as Date;
  let filtered = rows.filter(
    (r) =>
      r.gscPropertyId === propertyId &&
      r.date.getTime() >= start.getTime() &&
      r.date.getTime() <= end.getTime(),
  );

  let pIdx = 3;
  if (/"searchType" = \$/i.test(sql)) {
    const st = params[pIdx++] as string;
    filtered = filtered.filter((r) => r.searchType === st);
  }
  const eqMatches = Array.from(sql.matchAll(/"(query|page|country|device)" = \$/gi));
  for (const m of eqMatches) {
    const col = m[1] as keyof FakeGscDaily;
    const val = params[pIdx++] as string;
    filtered = filtered.filter((r) => r[col] === val);
  }

  if (/^\s*SELECT\s+COUNT\(\*\)/i.test(sql)) {
    const groupCols = parseGroupBy(sql);
    if (groupCols.length === 0) {
      return [{ total: filtered.length > 0 ? 1 : 0 }];
    }
    const distinct = new Set<string>();
    for (const r of filtered) {
      distinct.add(groupCols.map((c) => String(r[c])).join(""));
    }
    return [{ total: distinct.size }];
  }

  if (/SUM\(clicks\)/i.test(sql) && !/GROUP BY/i.test(sql)) {
    const clicks = filtered.reduce((acc, r) => acc + r.clicks, 0);
    const impressions = filtered.reduce((acc, r) => acc + r.impressions, 0);
    const position =
      impressions > 0
        ? filtered.reduce((acc, r) => acc + r.position * r.impressions, 0) /
          impressions
        : 0;
    return [{ clicks, impressions, position }];
  }

  const groupCols = parseGroupBy(sql);
  if (groupCols.length > 0) {
    const groups = new Map<string, FakeGscDaily[]>();
    for (const r of filtered) {
      const k = groupCols.map((c) => String(r[c])).join("");
      const arr = groups.get(k) ?? [];
      arr.push(r);
      groups.set(k, arr);
    }
    const out: Array<Record<string, unknown>> = [];
    for (const [, arr] of groups) {
      const clicks = arr.reduce((a, r) => a + r.clicks, 0);
      const impressions = arr.reduce((a, r) => a + r.impressions, 0);
      const position =
        impressions > 0
          ? arr.reduce((a, r) => a + r.position * r.impressions, 0) /
            impressions
          : 0;
      const ctr = impressions > 0 ? clicks / impressions : 0;
      const row: Record<string, unknown> = {
        clicks,
        impressions,
        position,
        ctr,
      };
      for (const col of groupCols) {
        row[col] = arr[0][col];
      }
      out.push(row);
    }
    const orderMatch = sql.match(/ORDER BY\s+("?\w+"?)\s+(ASC|DESC)/i);
    if (orderMatch) {
      const col = orderMatch[1].replace(/"/g, "");
      const dir = orderMatch[2].toUpperCase();
      out.sort((a, b) => {
        const av = a[col] as number | Date;
        const bv = b[col] as number | Date;
        const cmp =
          av instanceof Date && bv instanceof Date
            ? av.getTime() - bv.getTime()
            : Number(av) - Number(bv);
        return dir === "ASC" ? cmp : -cmp;
      });
    }
    return out;
  }

  return [];
}

function parseGroupBy(sql: string): Array<keyof FakeGscDaily> {
  const m = sql.match(/GROUP BY\s+(.+?)(?:\s+ORDER|\s*\)|\s*$)/is);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/"/g, "").replace(/^[^.]+\./, ""))
    .filter(Boolean) as Array<keyof FakeGscDaily>;
}
