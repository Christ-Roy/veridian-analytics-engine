/**
 * Rate limiter en mémoire pour `/api/ingest/form`.
 *
 * Stratégie sliding window simplifiée : bucket par clé (IP) avec compteur
 * + timestamp de premier hit. Reset complet quand le bucket dépasse
 * `windowMs`. Suffisant pour POC ; en prod on remplacera par Redis si
 * besoin (multi-instance).
 *
 * Limites configurables (default B1) :
 *   - 10 req/min par IP (anti-spam form classique)
 *   - bucket map plafonnée à 10_000 entrées (cleanup LRU à l'écriture)
 */

export interface RateLimiterOptions {
  /** Fenêtre glissante en ms (default 60_000 = 1min). */
  windowMs?: number;
  /** Max requêtes autorisées par fenêtre (default 10). */
  max?: number;
  /** Cap absolu du nombre de clés stockées (default 10_000). */
  maxKeys?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  /** Renvoie true si la requête est autorisée, false si bloquée. */
  check(key: string): boolean;
  /** Compteur courant pour debug/test. */
  size(): number;
  /** Reset complet — utile en tests. */
  reset(): void;
}

export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 10;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, Bucket>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        // Cap clés : si on dépasse maxKeys, on drop la plus vieille (Map
        // garde l'ordre d'insertion, donc keys().next() = la plus vieille).
        if (buckets.size >= maxKeys) {
          const first = buckets.keys().next().value;
          if (first !== undefined) buckets.delete(first);
        }
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (b.count >= max) return false;
      b.count++;
      return true;
    },
    size(): number {
      return buckets.size;
    },
    reset(): void {
      buckets.clear();
    },
  };
}
