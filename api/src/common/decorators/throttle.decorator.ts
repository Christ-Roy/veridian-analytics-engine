import { SkipThrottle, Throttle } from '@nestjs/throttler';

/**
 * Stricter rate limit for auth endpoints (10 req/min)
 * Applies only the 'auth' throttler.
 */
export function AuthThrottle() {
  return Throttle({ auth: { limit: 10, ttl: 60000 } });
}

/**
 * Higher rate limit for analytics endpoints (1000 req/min)
 * Dashboard queries can be frequent when users interact with charts.
 * Combined with caching to reduce actual DB load.
 */
export function AnalyticsThrottle() {
  return Throttle({
    analytics: { limit: 1000, ttl: 60000 },
    default: { limit: 1000, ttl: 60000 }, // Override default too
  });
}

/**
 * Skip ALL rate limiting for high-volume endpoints.
 * CRITICAL: With named throttlers, must explicitly skip each by name.
 * Use this on track endpoints that may receive millions of requests from same IP.
 */
export function SkipRateLimit() {
  return SkipThrottle({
    auth: true,
    default: true,
    analytics: true,
    ingest: true,
  });
}

/**
 * Rate limit for the public high-volume ingestion endpoint (/api/track).
 *
 * Ne JAMAIS appliquer un throttle par IP brute ici : des millions d'appareils
 * derrière un même NAT partagent l'IP → ça casserait le tracking légitime
 * (c'est pourquoi l'endpoint était historiquement @SkipRateLimit). À la place :
 *   - on n'active QUE le throttler `ingest` (généreux), les autres sont skip ;
 *   - CustomThrottlerGuard.getTracker bucket par (workspace_id + IP) pour
 *     /api/track, pas par IP seule → un gros site n'est jamais throttlé,
 *     seul un flood concentré (même ws + même IP) saute le plafond.
 *
 * Filet anti-DoS/flood SANS casser l'ingestion normale d'un gros site
 * (ticket ingest-track-aucun-ratelimit-dos 2026-06-23).
 */
export function IngestThrottle() {
  return SkipThrottle({ auth: true, default: true, analytics: true });
}

/**
 * Throttle généreux pour les routes M2M de LECTURE plateforme
 * (`/api/admin/platform/*` : analytics.query/funnel/conversions, *.status,
 * *.list*, *.get*, gsc.status, voip.list*, webhooks.list, ads.conversions…).
 *
 * Pourquoi : ces routes sont gardées par `PlatformAdminGuard` (seul le Hub /
 * la skill de provisioning détient la clé) et sont appelées EN RAFALE quand une
 * console charge plusieurs widgets dashboard en parallèle (status + plusieurs
 * query + conversions). Sans décorateur, elles héritent de TOUS les throttlers
 * globaux — dont `auth` (10/min) et `default` (100/min) — et le plus strict
 * l'emporte : la console se prenait des 429 après ~4 lectures rapprochées
 * (ticket robustesse-mineure P2 2026-06-23, getTracker bucket par IP partagée).
 *
 * Fix : on SKIP explicitement `auth`/`default`/`ingest` et on ne garde QUE
 * `analytics` (1000/min) — plafond aligné sur la lecture analytics client.
 * CRITIQUE : avec des throttlers nommés, il faut skip chaque nom non voulu,
 * sinon le bucket le plus strict s'applique quand même.
 */
export function ReadM2MThrottle() {
  return applyDecorators(
    SkipThrottle({ auth: true, default: true, ingest: true }),
    Throttle({ analytics: { limit: 1000, ttl: 60000 } }),
  );
}

/**
 * Throttle pour les routes M2M d'ÉCRITURE / provisioning plateforme
 * (`/api/admin/platform/*` : tenants.provision, *.provisionApiKey,
 * *.revokeApiKey, voip.save/add/remove/delete/testCredential/sync, gsc.resync,
 * webhooks.create/delete/test, *.set*, *.updateSettings, crm.setMapping,
 * tracking.verify). Les lectures pures — dont ads.conversions (read-only) —
 * passent en @ReadM2MThrottle().
 *
 * Plus serré que la lecture (ces opérations sont rares et coûteuses : write
 * DB, appels providers externes) mais SANS hériter du `auth: 10/min` qui n'a
 * aucun sens pour un consommateur M2M de confiance. 300/min couvre largement
 * un provisioning batch légitime du Hub tout en gardant un filet anti-abus si
 * la clé fuite. On skip `auth`/`analytics`/`ingest`, on garde `default` à 300.
 */
export function WriteM2MThrottle() {
  return applyDecorators(
    SkipThrottle({ auth: true, analytics: true, ingest: true }),
    Throttle({ default: { limit: 300, ttl: 60000 } }),
  );
}

// Re-export for custom use cases
export { SkipThrottle, Throttle };
