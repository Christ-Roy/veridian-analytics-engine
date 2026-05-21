/**
 * Prisma client singleton pour le bridge.
 *
 * On l'instancie une fois (HMR-safe via globalThis) et on l'exporte.
 * En tests, on peut override avec `setPrismaClientForTests()` pour pointer
 * vers une DB de test ou un mock.
 */

import { PrismaClient } from "@prisma/client";

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (_prisma) return _prisma;
  const g = globalThis as unknown as { __veridianBridgePrisma?: PrismaClient };
  if (g.__veridianBridgePrisma) {
    _prisma = g.__veridianBridgePrisma;
    return _prisma;
  }
  _prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  g.__veridianBridgePrisma = _prisma;
  return _prisma;
}

/**
 * Pour les tests : remplacer le client (ex : mock PrismaClient ou pointer
 * vers une DB sqlite/postgres de test).
 */
export function setPrismaClientForTests(client: PrismaClient | null): void {
  _prisma = client;
  const g = globalThis as unknown as { __veridianBridgePrisma?: PrismaClient | null };
  if (client) g.__veridianBridgePrisma = client;
  else delete (g as { __veridianBridgePrisma?: unknown }).__veridianBridgePrisma;
}
