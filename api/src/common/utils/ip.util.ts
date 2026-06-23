import { Request } from 'express';

/**
 * Basic IP validation (IPv4 and IPv6)
 */
export function isValidIp(ip: string): boolean {
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;

  // IPv6 pattern (simplified)
  const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

  // IPv4-mapped IPv6
  const ipv4MappedPattern = /^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i;

  return (
    ipv4Pattern.test(ip) || ipv6Pattern.test(ip) || ipv4MappedPattern.test(ip)
  );
}

/**
 * Normalize IP address format
 */
export function normalizeIp(ip: string): string {
  // Convert IPv4-mapped IPv6 to IPv4
  if (ip.toLowerCase().startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}

/**
 * Extract the real client IP address from the request.
 *
 * SÉCURITÉ (anti-spoofing — ticket ingest-spoofing-ip-xff 2026-06-23) :
 * la source de vérité est `req.ip`, calculé par Express en fonction de
 * `trust proxy` (configuré à 1 dans main.ts : un seul reverse-proxy de
 * confiance = Traefik). Avec ce réglage, Express ne retient du
 * `X-Forwarded-For` que les hops réellement posés par les proxies de
 * confiance et ignore tout ce qu'un client en connexion directe aurait
 * forgé. On NE lit donc PLUS le premier élément brut du XFF ni les headers
 * CDN (`cf-connecting-ip`, `true-client-ip`…) : dans notre topologie aucun
 * CDN n'est devant l'app, ces headers sont donc 100% client-fournis et
 * spoofables. S'y fier rouvrirait exactement la faille qu'on ferme.
 *
 * Fallback `req.socket.remoteAddress` si `trust proxy` n'est pas configuré
 * (ex. tests unitaires qui construisent un faux Request sans app Express).
 *
 * @returns The client IP address or null if not found
 */
export function getClientIp(req: Request): string | null {
  // Source fiable : req.ip dérivé de trust proxy (Express dé-spoofe le XFF).
  const trustedIp = req.ip;
  if (trustedIp) {
    const normalized = normalizeIp(trustedIp);
    if (isValidIp(normalized)) {
      return normalized;
    }
  }

  // Fallback to socket address (connexion directe / contexte de test sans
  // trust proxy). Toujours fiable car c'est l'IP TCP réelle, non spoofable.
  const socketIp = req.socket?.remoteAddress;
  if (socketIp) {
    const normalized = normalizeIp(socketIp);
    if (isValidIp(normalized)) {
      return normalized;
    }
  }

  return null;
}
