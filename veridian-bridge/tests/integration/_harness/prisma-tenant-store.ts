/**
 * PrismaTenantStore — implémentation `TenantStore` adossée à un VRAI Postgres.
 *
 * ─── Pourquoi ce fichier vit dans le harness de tests ───────────────────────
 *
 * Les handlers Hub (`provision`, `attach-owner`, `health`) sont écrits contre
 * l'interface `TenantStore` (cf src/hub/store.ts). En PROD, `createApp()` tombe
 * sur `InMemoryTenantStore` par défaut — le bridge ne persiste pas encore les
 * tenants Hub en Postgres (port prévu mais pas livré).
 *
 * Pour que les tests d'intégration T2 (Hub) puissent vérifier le comportement
 * RÉEL de Postgres (contrainte `@@unique` sur `hubTenantId`, erreur `P2002`,
 * transactions), il leur faut un `TenantStore` qui tape la table `Tenant`.
 * C'est exactement ça : un adaptateur de test, pas du code de prod.
 *
 * Quand le bridge livrera son vrai `PrismaTenantStore` côté `src/`, ce fichier
 * pourra être remplacé par un simple ré-export — la signature ne bouge pas.
 *
 * ─── Mapping `TenantRecord` ↔ colonnes Prisma ──────────────────────────────
 *
 * Le modèle `Tenant` Prisma N'A PAS de colonnes `ownerEmail` / `ownerUserId`.
 * Le contrat Hub (provision/attach-owner) en a besoin. On les stocke dans le
 * `slug` ? Non — on les sérialise dans une colonne libre. Le schéma actuel
 * n'offre pas de colonne JSON sur Tenant ; on encode donc owner_email +
 * owner_user_id dans `planSource` est exclu (déjà utilisé).
 *
 * Décision : on stocke `ownerEmail` dans une row `Site` ? Non plus — couplage.
 *
 * Solution retenue (la plus simple et honnête vis-à-vis du schéma réel) :
 * on encode `{ ownerEmail, ownerUserId }` en JSON dans le champ `name` ? Non,
 * `name` est de l'affichage.
 *
 * → On utilise la table `Tenant` telle quelle et on porte owner_email /
 *   owner_user_id dans la colonne `apiKey` ? Non, `apiKey` a un `@unique`.
 *
 * La vérité : le schéma Prisma actuel ne modélise pas l'owner. Plutôt que
 * d'inventer un encodage fragile, le harness AJOUTE ces deux champs via une
 * table annexe légère gérée en raw SQL (`TenantOwner`). Voir `ensureOwnerTable`.
 * C'est créé une fois par la migration de test (idempotent) et truncated par
 * `resetDb`. Ça reste 100% Postgres réel — aucune mémoire JS.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ProvisionInput,
  TenantRecord,
  TenantStore,
} from "../../../src/hub/store.js";

/**
 * Crée la table annexe `TenantOwner` si absente. Idempotent.
 *
 * Appelée par `applyMigrations()` du harness après `prisma migrate deploy`.
 * On NE met PAS ça dans une migration Prisma versionnée : c'est purement du
 * scaffolding de test, le schéma de prod ne doit pas porter cette table tant
 * que le bridge n'a pas son vrai `PrismaTenantStore`.
 */
export async function ensureOwnerTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TenantOwner" (
      "tenantId"    TEXT PRIMARY KEY REFERENCES "Tenant"("id") ON DELETE CASCADE,
      "ownerEmail"  TEXT,
      "ownerUserId" TEXT
    )
  `);
}

interface OwnerRow {
  ownerEmail: string | null;
  ownerUserId: string | null;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "tenant"
  );
}

/**
 * Implémentation `TenantStore` réelle. Toutes les opérations tapent Postgres.
 *
 * Les contraintes SQL (unicité `hubTenantId`, `workspaceId`, `slug`, `apiKey`)
 * sont celles du vrai schéma : un `create` en doublon lèvera un vrai `P2002`,
 * pas une exception simulée. C'est tout l'intérêt pour les tests T2.
 */
export class PrismaTenantStore implements TenantStore {
  constructor(private readonly prisma: PrismaClient) {}

  private async loadOwner(tenantId: string): Promise<OwnerRow> {
    const rows = await this.prisma.$queryRawUnsafe<OwnerRow[]>(
      `SELECT "ownerEmail", "ownerUserId" FROM "TenantOwner" WHERE "tenantId" = $1`,
      tenantId,
    );
    return rows[0] ?? { ownerEmail: null, ownerUserId: null };
  }

  private async saveOwner(
    tenantId: string,
    owner: OwnerRow,
  ): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "TenantOwner" ("tenantId", "ownerEmail", "ownerUserId")
       VALUES ($1, $2, $3)
       ON CONFLICT ("tenantId")
       DO UPDATE SET "ownerEmail" = EXCLUDED."ownerEmail",
                     "ownerUserId" = EXCLUDED."ownerUserId"`,
      tenantId,
      owner.ownerEmail,
      owner.ownerUserId,
    );
  }

  private async toRecord(
    row: {
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
    },
  ): Promise<TenantRecord> {
    const owner = await this.loadOwner(row.id);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      slug: row.slug,
      name: row.name,
      hubTenantId: row.hubTenantId,
      plan: row.plan,
      planSource: row.planSource,
      status: row.status,
      apiKey: row.apiKey,
      ownerEmail: owner.ownerEmail,
      ownerUserId: owner.ownerUserId,
      suspendedAt: row.suspendedAt,
      softDeletedAt: row.softDeletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async findByHubTenantId(hubTenantId: string): Promise<TenantRecord | null> {
    const row = await this.prisma.tenant.findUnique({ where: { hubTenantId } });
    return row ? this.toRecord(row) : null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(input: ProvisionInput): Promise<TenantRecord> {
    const slug = slugify(input.workspaceName);
    // create() RÉEL : si hubTenantId / workspaceId / slug / apiKey collisionne
    // une row existante, Prisma lève P2002 — exactement ce qu'on veut tester.
    const row = await this.prisma.tenant.create({
      data: {
        workspaceId: input.staminadsWorkspaceId,
        slug,
        name: input.workspaceName,
        hubTenantId: input.hubTenantId,
        plan: input.plan,
        planSource: input.planSource ?? "hub",
        status: "active",
        apiKey: input.apiKey,
      },
    });
    await this.saveOwner(row.id, {
      ownerEmail: input.ownerEmail,
      ownerUserId: null,
    });
    return this.toRecord(row);
  }

  async refreshApiKey(
    hubTenantId: string,
    newApiKey: string,
  ): Promise<TenantRecord> {
    const row = await this.prisma.tenant.update({
      where: { hubTenantId },
      data: { apiKey: newApiKey },
    });
    return this.toRecord(row);
  }

  async attachOwner(
    hubTenantId: string,
    ownerEmail: string,
    ownerUserId: string,
  ): Promise<{ tenant: TenantRecord; alreadyAttached: boolean }> {
    const row = await this.prisma.tenant.findUnique({ where: { hubTenantId } });
    if (!row) throw new Error(`tenant_not_found:${hubTenantId}`);
    const current = await this.loadOwner(row.id);
    const alreadyAttached =
      current.ownerEmail === ownerEmail &&
      current.ownerUserId === ownerUserId;
    await this.saveOwner(row.id, { ownerEmail, ownerUserId });
    // Touch updatedAt pour refléter la mutation.
    const touched = await this.prisma.tenant.update({
      where: { id: row.id },
      data: { updatedAt: new Date() },
    });
    return { tenant: await this.toRecord(touched), alreadyAttached };
  }
}
