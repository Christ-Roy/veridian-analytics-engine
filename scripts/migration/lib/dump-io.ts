/**
 * I/O des fichiers de dump legacy.
 *
 * Les scripts de migration d'historique (GSC, Forms) NE se connectent PAS
 * directement à la BDD legacy. Raison : éviter d'ajouter une dépendance `pg`
 * (lockfile, audit CVE) et garder les scripts rejouables/testables hors-ligne.
 *
 * Le flux est en 2 temps :
 *   1. L'opérateur exporte les tables legacy en JSON (commande documentée
 *      dans README.md — `psql ... -c "COPY (SELECT ...) TO STDOUT"` ou
 *      `\copy ... TO ... (FORMAT json)` selon la version Postgres).
 *   2. Le script de migration consomme ce fichier JSON.
 *
 * Format attendu : un fichier JSON contenant un tableau d'objets, OU un
 * fichier NDJSON (un objet JSON par ligne). On supporte les deux car
 * `psql --csv`/`COPY ... json` produit du NDJSON et `pg_dump`-export-script
 * produit souvent un array.
 */

import { readFileSync, existsSync } from "node:fs";

/**
 * Lit un fichier de dump legacy → tableau d'objets.
 * Supporte JSON array ET NDJSON (une ligne = un objet).
 */
export function readDumpFile<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) {
    throw new Error(`dump file introuvable: ${path}`);
  }
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) return [];

  // JSON array ?
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`dump ${path} : JSON racine doit être un array`);
    }
    return parsed as T[];
  }

  // Sinon NDJSON : un objet par ligne.
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch (err) {
        throw new Error(
          `dump ${path} : ligne ${i + 1} JSON invalide — ${(err as Error).message}`,
        );
      }
    });
}

/**
 * Filtre les rows d'un dump pour ne garder que celles d'un `siteId` legacy
 * donné. Les dumps peuvent contenir plusieurs sites — la migration traite
 * un client à la fois.
 */
export function filterBySiteId<T extends { siteId: string }>(
  rows: T[],
  legacySiteId: string,
): T[] {
  return rows.filter((r) => r.siteId === legacySiteId);
}
