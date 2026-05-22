/**
 * Sanitization du payload `data` reçu par /api/ingest/form.
 *
 * Le payload est stocké en JSONB Postgres — il n'est jamais `eval()`é côté
 * back, donc le risque réel est qu'il soit *rendu* côté dashboard.
 *
 * Stratégie défensive :
 *   1. Aucune balise HTML/script n'est conservée. On strippe tout
 *      `<...>` y compris les attributs (`<script>`, `<img onerror=...>`,
 *      `<iframe>`, etc.).
 *   2. Les protocoles dangereux `javascript:` / `data:` sont blanchis.
 *   3. Limites de taille : 200 clés max, 8 KiB par valeur string (anti-DoS).
 *
 * Le test xss-sanitization.test.ts (B1 bonus) couvre ces 3 axes.
 */

const MAX_KEYS = 200;
const MAX_STRING_LEN = 8 * 1024;
// Strippe toute balise HTML (<...>) y compris attributs et contenu mal-formé.
// Volontairement permissif (pas une lib HTML complète) : c'est une couche
// défense-en-profondeur, le rendu front DOIT aussi échapper.
const HTML_TAG_RE = /<[^>]*>?/g;
const DANGEROUS_PROTO_RE = /\b(javascript|data|vbscript)\s*:/gi;

export function sanitizeString(input: string): string {
  let v = input.length > MAX_STRING_LEN ? input.slice(0, MAX_STRING_LEN) : input;
  v = v.replace(HTML_TAG_RE, "");
  v = v.replace(DANGEROUS_PROTO_RE, "blocked:");
  return v;
}

/**
 * Sanitize récursivement un payload JSON. Garde la structure mais nettoie
 * toutes les feuilles string. Tronque les objets à MAX_KEYS clés.
 */
export function sanitizePayload(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return sanitizeString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (Array.isArray(input)) {
    return input.slice(0, MAX_KEYS).map((v) => sanitizePayload(v));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (count >= MAX_KEYS) break;
      // Sanitize key aussi (pas censé contenir d'HTML, mais par défense).
      const safeKey = sanitizeString(String(k)).slice(0, 200);
      out[safeKey] = sanitizePayload(v);
      count++;
    }
    return out;
  }
  // Types non-JSON (function, symbol, bigint) — on drop.
  return null;
}

/**
 * Extrait email + phone + name d'un payload arbitraire en cherchant des
 * clés usuelles. Renvoie `null` si rien trouvé.
 *
 * Email validé par regex simple (suffisant — pas d'envoi de mail ici).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function extractLeadFields(data: Record<string, unknown>): {
  email: string | null;
  phone: string | null;
  name: string | null;
} {
  const lc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    lc[k.toLowerCase()] = v;
  }

  const emailRaw =
    typeof lc.email === "string"
      ? lc.email
      : typeof lc.mail === "string"
        ? (lc.mail as string)
        : null;
  const email =
    emailRaw && EMAIL_RE.test(emailRaw.trim().toLowerCase())
      ? emailRaw.trim().toLowerCase()
      : null;

  const phoneRaw =
    typeof lc.phone === "string"
      ? (lc.phone as string)
      : typeof lc.tel === "string"
        ? (lc.tel as string)
        : typeof lc.telephone === "string"
          ? (lc.telephone as string)
          : null;
  const phone = phoneRaw ? phoneRaw.trim().slice(0, 50) : null;

  const nameRaw =
    typeof lc.name === "string"
      ? (lc.name as string)
      : typeof lc.fullname === "string"
        ? (lc.fullname as string)
        : typeof lc.nom === "string"
          ? (lc.nom as string)
          : null;
  const name = nameRaw ? nameRaw.trim().slice(0, 200) : null;

  return { email, phone, name };
}
