/**
 * Types et constantes pour la feature Google Search Console (GSC) intégrée
 * dans la console staminads via l'onglet Settings « Search Console » (cf
 * `console/src/veridian/settings-panels/search-console-panel.tsx`).
 *
 * Refonte 2026-05-23 (refactor/ui-native-pure) : la sous-route dédiée
 * `/search-console` a été supprimée — GSC vit désormais inline dans
 * Settings, avec connexion OAuth + KPIs + chart + data-table.
 *
 * Port direct du legacy `veridian-analytics/components/gsc/types.ts`, sans
 * dépendances Next.js — utilisable depuis Vite/React.
 */

export type MetricKey = 'clicks' | 'impressions' | 'ctr' | 'position';

export type DimensionKey =
  | 'query'
  | 'page'
  | 'country'
  | 'device'
  | 'date'
  | 'searchAppearance';

export type SearchType =
  | 'web'
  | 'image'
  | 'video'
  | 'news'
  | 'discover'
  | 'googleNews';

export type GscFilter = {
  dimension: 'query' | 'page' | 'country' | 'device';
  operator:
    | 'equals'
    | 'notEquals'
    | 'contains'
    | 'notContains'
    | 'includingRegex'
    | 'excludingRegex';
  expression: string;
};

export type QueryRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type QueryResponse = {
  rows: QueryRow[];
  totalRows: number;
  totals: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
};

/**
 * Réponse de `GET /api/admin/tenant/:workspaceId/gsc?days=N` — miroir du
 * handler `dashboardSummary` du bridge (cf `veridian-bridge/src/gsc/query.ts`).
 *
 * `property: null` → le tenant n'a pas encore connecté sa Search Console.
 * L'UI affiche alors un état d'onboarding propre.
 */
export type GscDashboardResponse = {
  workspaceId: string;
  days: number;
  property: { id: string; siteUrl: string } | null;
  totals: QueryResponse['totals'];
  topQueries: QueryRow[];
  topPages: QueryRow[];
  timeseries: QueryRow[];
};

export const METRIC_META: Record<
  MetricKey,
  { label: string; color: string; format: (v: number) => string }
> = {
  clicks: {
    label: 'Clics',
    color: '#3b82f6', // blue-500
    format: (v) => new Intl.NumberFormat('fr-FR').format(Math.round(v)),
  },
  impressions: {
    label: 'Impressions',
    color: '#8b5cf6', // violet-500
    format: (v) => new Intl.NumberFormat('fr-FR').format(Math.round(v)),
  },
  ctr: {
    label: 'CTR',
    color: '#10b981', // emerald-500
    format: (v) => (v * 100).toFixed(1) + '%',
  },
  position: {
    label: 'Position',
    color: '#f59e0b', // amber-500
    format: (v) => v.toFixed(1),
  },
};

export const DIMENSION_META: Record<
  DimensionKey,
  { label: string; icon: string }
> = {
  query: { label: 'Mots-clés', icon: '🔎' },
  page: { label: 'Pages', icon: '📄' },
  country: { label: 'Pays', icon: '🌍' },
  device: { label: 'Appareils', icon: '💻' },
  date: { label: 'Dates', icon: '📅' },
  searchAppearance: { label: 'Apparence', icon: '✨' },
};

export const DATE_RANGES: Array<{
  value: string;
  label: string;
  days: number;
}> = [
  { value: '7d', label: '7 derniers jours', days: 7 },
  { value: '28d', label: '28 derniers jours', days: 28 },
  { value: '90d', label: '3 derniers mois', days: 90 },
];

export const SEARCH_TYPES: Array<{ value: SearchType; label: string }> = [
  { value: 'web', label: 'Web' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Vidéo' },
  { value: 'news', label: 'Actualités' },
];
