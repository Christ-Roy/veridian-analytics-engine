/**
 * Helper de seeding pour les tests d'intégration Push (T5).
 *
 * Pourquoi ce fichier existe — le piège de `seedTenant` cross-process :
 *
 *   Le harness `seedTenant()` génère ses valeurs uniques via un compteur de
 *   MODULE (`seedCounter`). `node --test` exécute les fichiers d'intégration
 *   en PLUSIEURS PROCESSUS parallèles : chaque process repart de `seedCounter
 *   = 0`. Résultat : deux fichiers produisent tous deux `seed-tenant-1`,
 *   `hub_seed_1`, `sk_seed_1`… → collision sur les colonnes `@unique`
 *   (`slug`, `hubTenantId`, `apiKey`) du même Postgres partagé → P2002.
 *
 *   `seedTenantUnique()` surcharge TOUTES les colonnes `@unique` du modèle
 *   `Tenant` avec un `randomUUID()` — globalement unique, donc sûr quel que
 *   soit le nombre de process/fichiers parallèles.
 *
 * Le nom de fichier (`_seed.ts`, pas `*.test.ts`) le tient hors du glob de
 * `node --test` : c'est un module utilitaire, pas une suite.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { seedTenant } from "../_harness/index.js";

/**
 * Seede un `Tenant` réel dont TOUTES les colonnes `@unique` sont aléatoires.
 *
 * @param prisma  client Prisma du harness (`h.prisma`)
 * @param label   préfixe lisible injecté dans le `workspaceId` (debug)
 */
export function seedTenantUnique(prisma: PrismaClient, label: string) {
  const id = randomUUID();
  return seedTenant(prisma, {
    workspaceId: `ws_${label}_${id}`,
    slug: `slug-${label}-${id}`,
    hubTenantId: `hub_${label}_${id}`,
    apiKey: `sk_${label}_${id}`,
  });
}
