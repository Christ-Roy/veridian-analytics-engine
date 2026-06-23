/**
 * Libellés français des VALEURS de canal (channel / channel_group) dérivées à
 * l'ingestion (cf api/src/events/derive-channel.ts). Source unique pour le funnel,
 * les conversions par canal et tout affichage qui montre un canal en clair.
 *
 * `channel_group` est aligné 1:1 sur `phone_source` (ads/seo/social/email/
 * referral/direct/other) → web et appels téléphoniques partagent ces libellés.
 */

/** Libellés des valeurs fines de `channel` (GA4-like). */
export const CHANNEL_LABELS_FR: Record<string, string> = {
  paid_search: 'Recherche payante',
  organic_search: 'Recherche organique',
  paid_social: 'Social payant',
  organic_social: 'Social organique',
  email: 'Email',
  referral: 'Référent',
  direct: 'Direct',
  other: 'Autre',
}

/** Libellés des valeurs coarse de `channel_group` (alignées phone_source). */
export const CHANNEL_GROUP_LABELS_FR: Record<string, string> = {
  ads: 'Publicité (Ads)',
  seo: 'Référencement (SEO)',
  social: 'Réseaux sociaux',
  email: 'Email',
  referral: 'Référents',
  direct: 'Direct',
  other: 'Autre',
}

/** Ordre d'affichage canonique des groupes de canaux. */
export const CHANNEL_GROUP_ORDER = [
  'ads',
  'seo',
  'social',
  'email',
  'referral',
  'direct',
  'other',
] as const

export function channelLabel(value: string): string {
  return CHANNEL_LABELS_FR[value] ?? value ?? '(vide)'
}

export function channelGroupLabel(value: string): string {
  if (!value) return '(non attribué)'
  return CHANNEL_GROUP_LABELS_FR[value] ?? value
}
