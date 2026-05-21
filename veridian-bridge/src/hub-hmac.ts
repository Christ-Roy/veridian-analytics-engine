/**
 * HMAC Hub — vérification des requêtes signées par le Hub Veridian.
 *
 * Pattern A du CONTRAT-HUB.md §6.1.
 *
 * Header attendus côté requête entrante :
 *   - X-Veridian-Timestamp     : unix ms (l'horloge du Hub au moment de la signature)
 *   - X-Veridian-Hub-Signature : hex(HMAC-SHA256(secret, "{timestamp}.{raw_body}"))
 *
 * Règles obligatoires :
 *   - Anti-replay : reject si |now - timestamp| > 5min
 *   - Comparaison constant-time via crypto.timingSafeEqual
 *   - Le body est comparé en RAW (octets bruts) — pas re-stringifié
 *
 * Mode dev local : si SKIP_HMAC=true ET NODE_ENV ∈ {test, development}, le
 * middleware laisse passer la requête en loggant un warning. Toute autre
 * valeur de NODE_ENV avec SKIP_HMAC=true → throw au boot (cf assertSkipHmacAllowed).
 */

import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const FIVE_MIN_MS = 5 * 60 * 1000;

/** Erreur exposée pour debug — pas envoyée au client (on retourne 401 standard). */
export type HmacError =
  | "missing_timestamp"
  | "missing_signature"
  | "invalid_timestamp"
  | "timestamp_drift"
  | "invalid_signature";

export interface HmacVerifyResult {
  valid: boolean;
  error?: HmacError;
}

export interface HmacOptions {
  /** Secret partagé Hub ↔ app. Doit être ≥ 32 chars. */
  secret: string;
  /** Si true et env autorisé, bypass complet. Log un warning à chaque hit. */
  skipHmac?: boolean;
  /** Override clock pour tests. Default : Date.now(). */
  now?: () => number;
  /** Window anti-replay en ms. Default : 5 min. */
  maxDriftMs?: number;
}

/**
 * Garde-fou boot : refuse SKIP_HMAC=true en prod/staging.
 *
 * À appeler depuis index.ts AVANT createApp. Throw si SKIP_HMAC=true et que
 * NODE_ENV n'est ni 'test' ni 'development'.
 */
export function assertSkipHmacAllowed(
  skipHmac: boolean,
  nodeEnv: string | undefined
): void {
  if (!skipHmac) return;
  const env = (nodeEnv ?? "production").toLowerCase();
  if (env !== "test" && env !== "development") {
    throw new Error(
      `SKIP_HMAC=true interdit en NODE_ENV=${env}. Refuse de booter.`
    );
  }
}

/**
 * Vérifie la signature HMAC d'une requête Hub.
 *
 * `rawBody` doit être le body EXACT reçu (string utf8 issu d'un middleware
 * type rawBodyParser, pas un JSON.stringify côté serveur — ça casserait la
 * signature au moindre changement d'espace).
 */
export function verifyHubHmac(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  opts: HmacOptions
): HmacVerifyResult {
  if (opts.skipHmac) {
    return { valid: true };
  }

  const tsHeader = headerOf(headers, "x-veridian-timestamp");
  const sigHeader = headerOf(headers, "x-veridian-hub-signature");

  if (!tsHeader) return { valid: false, error: "missing_timestamp" };
  if (!sigHeader) return { valid: false, error: "missing_signature" };

  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { valid: false, error: "invalid_timestamp" };
  }

  const now = (opts.now ?? Date.now)();
  const drift = Math.abs(now - ts);
  const maxDrift = opts.maxDriftMs ?? FIVE_MIN_MS;
  if (drift > maxDrift) {
    return { valid: false, error: "timestamp_drift" };
  }

  const expected = crypto
    .createHmac("sha256", opts.secret)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");

  // timingSafeEqual exige des buffers de même taille — short-circuit propre
  // sinon (sinon throw, fuite un bit d'info via la stacktrace).
  if (expected.length !== sigHeader.length) {
    return { valid: false, error: "invalid_signature" };
  }

  const ok = crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(sigHeader, "utf8")
  );
  return ok ? { valid: true } : { valid: false, error: "invalid_signature" };
}

/**
 * Middleware Express qui :
 *   1. Capture le raw body avant que express.json() ne le parse
 *   2. Vérifie la signature HMAC
 *   3. Délègue à next() si OK, retourne 401 sinon
 *
 * À utiliser AVANT express.json() sur les routes Hub. Ce middleware parse
 * lui-même le JSON et le pose dans `req.body` pour que les handlers downstream
 * n'aient pas à se soucier du double-parse.
 */
export function hubHmacMiddleware(opts: HmacOptions) {
  return function hubHmac(req: Request, res: Response, next: NextFunction): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const result = verifyHubHmac(rawBody, req.headers, opts);
      if (!result.valid) {
        if (opts.skipHmac) {
          // Path normalement inatteignable (skipHmac → valid:true) mais on
          // garde une trace si on évolue plus tard
          console.warn("[hub-hmac] SKIP_HMAC active but verify returned false");
        }
        res.status(401).json({
          error: "unauthorized",
          error_code: result.error ?? "invalid_signature",
        });
        return;
      }
      if (opts.skipHmac) {
        console.warn(
          "[hub-hmac] HMAC bypass via SKIP_HMAC, NEVER in prod (path=%s)",
          req.path
        );
      }
      // Parse body pour les handlers downstream (sans re-déclencher express.json)
      if (rawBody.length > 0) {
        try {
          req.body = JSON.parse(rawBody);
        } catch {
          res.status(400).json({ error: "invalid_json" });
          return;
        }
      } else {
        req.body = {};
      }
      next();
    });
    req.on("error", (err) => {
      res.status(400).json({ error: "body_read_error", message: err.message });
    });
  };
}

/**
 * Helper symétrique côté Hub (ou tests) : produit les headers signés à
 * envoyer au bridge.
 */
export function signHubRequest(
  body: string,
  secret: string,
  now?: number
): { timestamp: string; signature: string } {
  const ts = String(now ?? Date.now());
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${body}`, "utf8")
    .digest("hex");
  return { timestamp: ts, signature };
}

function headerOf(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
