/**
 * GSC daily row — une ligne agrégée Search Console par
 * (property, date, query, page, country, device, search_type).
 *
 * Stockée dans la system DB ClickHouse (`gsc_daily`). C'est de la donnée
 * analytique relationnelle (pas des events de tracking), d'où le choix system
 * DB + ReplacingMergeTree pour l'idempotence du sync : re-sync d'une même
 * fenêtre = ré-insertion avec le même ORDER BY → la version la plus récente
 * (updated_at) gagne, pas de doublon après FINAL.
 *
 * ctr / position sont stockés tels que renvoyés par l'API GSC (par row). Les
 * agrégats lus par le dashboard recomputent CTR et la position pondérée par les
 * impressions (cf gsc-query.service.ts) — ne JAMAIS moyenner naïvement la
 * position sur des rows de granularités différentes.
 */

export type GscSearchType =
  | 'web'
  | 'image'
  | 'video'
  | 'news'
  | 'discover'
  | 'googleNews';

export interface GscDailyRow {
  gsc_property_id: string;
  workspace_id: string;
  /** Date du jour GSC au format `YYYY-MM-DD`. */
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  search_type: GscSearchType;
  impressions: number;
  clicks: number;
  /** Position moyenne de la row (1 = top). */
  position: number;
  /** CTR brut de la row (0..1). */
  ctr: number;
}
