/**
 * TenantStore — abstraction lookup tenant.
 *
 * Architecture : on isole l'accès BDD derrière une interface pour que :
 *   - B3 (ce ticket) puisse livrer les endpoints HMAC + tests UNITAIRES
 *     sans dépendre de A4 / Prisma.
 *   - Une fois A4 mergée, on substitue l'impl `InMemoryTenantStore` par
 *     `PrismaTenantStore` dans un seul fichier sans toucher aux handlers.
 *
 * Le shape `TenantRecord` reflète les colonnes du schéma Prisma de A4 :
 *   model Tenant {
 *     id, workspaceId, slug, name,
 *     hubTenantId?, plan, planSource?, status, apiKey?,
 *     suspendedAt?, softDeletedAt?,
 *     createdAt, updatedAt
 *   }
 */

export interface TenantRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  hubTenantId: string | null;
  plan: string;
  planSource: string | null;
  status: string; // "active" | "suspended" | "soft_deleted" | "trial_expired"
  apiKey: string | null;
  ownerEmail: string | null;
  ownerUserId: string | null;
  suspendedAt: Date | null;
  softDeletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Stats live (chargées à la demande par /health)
  lastEventAt?: Date | null;
  sitesCount?: number;
  pageviews30d?: number;
}

export interface ProvisionInput {
  hubTenantId: string;
  workspaceName: string;
  ownerEmail: string;
  plan: string;
  planSource?: string;
  apiKey: string;
  /** workspaceId staminads (renvoyé par le hook createStaminadsWorkspace). */
  staminadsWorkspaceId: string;
  metadata?: Record<string, unknown>;
}

export interface TenantStore {
  findByHubTenantId(hubTenantId: string): Promise<TenantRecord | null>;
  findById(id: string): Promise<TenantRecord | null>;
  create(input: ProvisionInput): Promise<TenantRecord>;
  /** Refresh api_key + retourne le tenant existant (Cas B). */
  refreshApiKey(hubTenantId: string, newApiKey: string): Promise<TenantRecord>;
  attachOwner(
    hubTenantId: string,
    ownerEmail: string,
    ownerUserId: string
  ): Promise<{ tenant: TenantRecord; alreadyAttached: boolean }>;
}

/**
 * Impl en mémoire — pour les tests UNITAIRES B3.
 *
 * À remplacer par `PrismaTenantStore` une fois A4 mergée. Le contrat de cette
 * interface ne change pas — seule l'impl concrète bascule.
 */
export class InMemoryTenantStore implements TenantStore {
  private byHubId = new Map<string, TenantRecord>();
  private byId = new Map<string, TenantRecord>();

  async findByHubTenantId(hubTenantId: string): Promise<TenantRecord | null> {
    return this.byHubId.get(hubTenantId) ?? null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async create(input: ProvisionInput): Promise<TenantRecord> {
    const now = new Date();
    const id = `tnt_${Math.random().toString(36).slice(2, 10)}`;
    const slug = input.workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "tenant";
    const rec: TenantRecord = {
      id,
      workspaceId: input.staminadsWorkspaceId,
      slug,
      name: input.workspaceName,
      hubTenantId: input.hubTenantId,
      plan: input.plan,
      planSource: input.planSource ?? "hub",
      status: "active",
      apiKey: input.apiKey,
      ownerEmail: input.ownerEmail,
      ownerUserId: null,
      suspendedAt: null,
      softDeletedAt: null,
      createdAt: now,
      updatedAt: now,
      lastEventAt: null,
      sitesCount: 0,
      pageviews30d: 0,
    };
    this.byHubId.set(input.hubTenantId, rec);
    this.byId.set(id, rec);
    return rec;
  }

  async refreshApiKey(
    hubTenantId: string,
    newApiKey: string
  ): Promise<TenantRecord> {
    const existing = this.byHubId.get(hubTenantId);
    if (!existing) throw new Error(`tenant_not_found:${hubTenantId}`);
    const updated: TenantRecord = {
      ...existing,
      apiKey: newApiKey,
      updatedAt: new Date(),
    };
    this.byHubId.set(hubTenantId, updated);
    this.byId.set(updated.id, updated);
    return updated;
  }

  async attachOwner(
    hubTenantId: string,
    ownerEmail: string,
    ownerUserId: string
  ): Promise<{ tenant: TenantRecord; alreadyAttached: boolean }> {
    const existing = this.byHubId.get(hubTenantId);
    if (!existing) throw new Error(`tenant_not_found:${hubTenantId}`);
    const alreadyAttached =
      existing.ownerEmail === ownerEmail && existing.ownerUserId === ownerUserId;
    const updated: TenantRecord = {
      ...existing,
      ownerEmail,
      ownerUserId,
      updatedAt: new Date(),
    };
    this.byHubId.set(hubTenantId, updated);
    this.byId.set(updated.id, updated);
    return { tenant: updated, alreadyAttached };
  }

  // ─── Helpers de test ──────────────────────────────────────────────────
  /** Force la mutation d'un tenant (tests : changer status pour paywall). */
  _setStatus(hubTenantId: string, status: string): void {
    const t = this.byHubId.get(hubTenantId);
    if (!t) throw new Error(`tenant_not_found:${hubTenantId}`);
    t.status = status;
    this.byId.set(t.id, t);
  }

  /** Force les stats pour /health. */
  _setStats(
    hubTenantId: string,
    stats: { lastEventAt?: Date; sitesCount?: number; pageviews30d?: number }
  ): void {
    const t = this.byHubId.get(hubTenantId);
    if (!t) throw new Error(`tenant_not_found:${hubTenantId}`);
    Object.assign(t, stats);
    this.byId.set(t.id, t);
  }

  _all(): TenantRecord[] {
    return [...this.byId.values()];
  }
}
