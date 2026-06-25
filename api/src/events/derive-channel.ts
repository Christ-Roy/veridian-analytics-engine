/**
 * Dérivation déterministe du canal d'acquisition (`channel` / `channel_group`)
 * à partir des signaux DÉJÀ captés à l'ingestion (utm_*, gclid/gbraid/wbraid via
 * `utm_id_from`, referrer / referrer_domain, is_direct).
 *
 * Pourquoi ici (et pas en SQL au query-time) : le canal est figé à l'ingestion
 * (perf + immuabilité de l'attribution d'acquisition). `sessions_mv` /
 * `goals_mv` propagent ensuite `any(e.channel)` → sessions/goals sans calcul
 * supplémentaire. Le socle de tout le funnel/filtre par canal (S1 du chantier
 * attribution 2026-06-23).
 *
 * Deux niveaux de granularité, par DESIGN :
 *   - `channel`        : valeur GA4-like fine (paid_search, organic_search,
 *                        paid_social, organic_social, email, referral, direct,
 *                        other). C'est la "Default Channel Grouping" de GA4,
 *                        utile pour un reporting analytics détaillé.
 *   - `channel_group`  : valeur COARSE alignée 1:1 avec `phone_source`
 *                        (ads / seo / social / email / referral / direct /
 *                        other) pour que web ↔ appel téléphonique soient
 *                        comparables dans la MÊME dimension. Un appel attribué
 *                        `phone_source='seo'` et une session web
 *                        `channel_group='seo'` se filtrent/agrègent ensemble.
 *
 * 100% pur / déterministe / sans I/O → trivialement testable (table de cas).
 */

/** Valeurs fines (GA4-like) de `channel`. */
export const CHANNELS = [
  'paid_search',
  'organic_search',
  'paid_social',
  'organic_social',
  'email',
  'referral',
  'direct',
  'other',
] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Valeurs coarse de `channel_group`, alignées sur `PHONE_NUMBER_SOURCES`
 * (voip.types.ts) pour la cohérence web↔appel. `print` n'a pas d'équivalent web
 * (un appel print existe, une session web non) → on ne le produit jamais ici.
 */
export const CHANNEL_GROUPS = [
  'ads',
  'seo',
  'social',
  'email',
  'referral',
  'direct',
  'other',
] as const;
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number];

export interface ChannelResult {
  channel: Channel;
  channel_group: ChannelGroup;
}

/** Signaux d'acquisition disponibles à l'ingestion. */
export interface ChannelSignals {
  /** referrer_domain déjà parsé (hostname) ; vide si direct. */
  referrer_domain?: string | null;
  /** referrer brut (fallback si le domaine n'a pas pu être parsé). */
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  /** Origine de l'utm_id : 'gclid' | 'gbraid' | 'wbraid' (Google Ads click id). */
  utm_id_from?: string | null;
  /** true si aucun referrer (navigation directe / bookmark / app). */
  is_direct?: boolean;
  /**
   * Code de parrainage interne extrait de `?ref=<code>` sur la landing page
   * (param configurable `settings.referral_param`, défaut `ref`). Parsé EN AMONT
   * (dans le handler d'ingestion), JAMAIS ici — deriveChannel reste pure/sans I/O.
   * Non vide ⇒ ce visiteur arrive via un lien de parrainage interne (viralité du
   * client). Sert UNIQUEMENT à récupérer du trafic autrement classé `direct` :
   * il ne masque jamais un canal plus riche (gclid / utm payant / vrai referrer
   * externe priment, cf branche 4bis). Le code lui-même est stocké à part dans
   * `utm_content` par le handler, indépendamment du canal final.
   */
  referral_code?: string | null;
}

// ─── Référentiels de domaines (déterministes, France-aware) ────────────────────
// Volontairement compacts : on matche par SUFFIXE de domaine (eTLD-agnostic) pour
// couvrir google.com / google.fr / www.google.de d'un coup. Listes maintenables
// à la main — aucune dépendance externe (cf règle "zéro dep npm nouvelle").

/** Moteurs de recherche (organic_search). */
const SEARCH_ENGINE_DOMAINS = [
  'google.',
  'bing.',
  'yahoo.',
  'duckduckgo.com',
  'qwant.com',
  'ecosia.org',
  'startpage.com',
  'baidu.com',
  'yandex.',
  'ask.com',
  'aol.com',
  'brave.com',
  'search.brave.com',
];

/** Réseaux sociaux (social). Inclut messageries (whatsapp/messenger). */
const SOCIAL_DOMAINS = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'l.facebook.com',
  'lm.facebook.com',
  'm.facebook.com',
  'instagram.com',
  'l.instagram.com',
  'linkedin.com',
  'lnkd.in',
  'twitter.com',
  'x.com',
  't.co',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'pinterest.',
  'reddit.com',
  'snapchat.com',
  'tumblr.com',
  'threads.net',
  'mastodon.',
  'whatsapp.com',
  'wa.me',
  'messenger.com',
  'discord.com',
  'discord.gg',
  'telegram.org',
  't.me',
];

/** Webmails / domaines email (email). */
const EMAIL_DOMAINS = [
  'mail.google.com',
  'outlook.',
  'outlook.live.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'protonmail.com',
  'mail.com',
  'gmx.',
  'laposte.net',
  'orange.fr',
  'free.fr',
  'sfr.fr',
];

/** Click ids Google Ads → paid_search. */
const PAID_SEARCH_CLICK_IDS = new Set(['gclid', 'gbraid', 'wbraid']);

/** utm_medium considérés payants. */
const PAID_MEDIUMS = new Set([
  'cpc',
  'ppc',
  'paid',
  'paidsearch',
  'paid_search',
  'paid-search',
  'sem',
  'cpm',
  'cpv',
  'cpa',
  'display',
  'banner',
  'retargeting',
]);

/** utm_medium "social" PAYANTS (→ paid_social). */
const PAID_SOCIAL_MEDIUMS = new Set([
  'paidsocial',
  'paid_social',
  'paid-social',
]);

/** utm_medium "social" (payants OU organiques). */
const SOCIAL_MEDIUMS = new Set([
  'social',
  'social-media',
  'social_media',
  'sm',
  ...PAID_SOCIAL_MEDIUMS,
]);

/** utm_medium considérés "email". */
const EMAIL_MEDIUMS = new Set(['email', 'e-mail', 'newsletter', 'mail']);

/** utm_medium considérés "referral". */
const REFERRAL_MEDIUMS = new Set([
  'referral',
  'referrer',
  'link',
  'affiliate',
  'partner',
]);

/** utm_medium considérés "organic" (search). */
const ORGANIC_MEDIUMS = new Set(['organic', 'organic_search']);

function norm(v?: string | null): string {
  return (v ?? '').trim().toLowerCase();
}

/** Vrai si `domain` se termine par / contient l'un des suffixes listés. */
function domainMatches(domain: string, suffixes: string[]): boolean {
  if (!domain) return false;
  return suffixes.some((s) =>
    s.endsWith('.')
      ? // suffixe de type "google." → matche un label "google" suivi d'un TLD
        domain === s.slice(0, -1) ||
        domain.includes(`${s}`) ||
        domain.startsWith(s)
      : domain === s || domain.endsWith(`.${s}`),
  );
}

/** Coarse group dérivé d'un channel fin. */
function toChannelGroup(channel: Channel): ChannelGroup {
  switch (channel) {
    case 'paid_search':
      return 'ads';
    case 'organic_search':
      return 'seo';
    case 'paid_social':
    case 'organic_social':
      return 'social';
    case 'email':
      return 'email';
    case 'referral':
      return 'referral';
    case 'direct':
      return 'direct';
    default:
      return 'other';
  }
}

/**
 * Dérive le canal d'acquisition. Ordre de priorité (du plus fort signal au plus
 * faible), aligné sur la "Default Channel Grouping" GA4 et la table du ticket :
 *
 *   1. Google Ads click id (gclid/gbraid/wbraid)      → paid_search
 *   2. utm_medium payant                              → paid_search / paid_social
 *   3. utm_medium social / email / referral / organic → channel correspondant
 *   4. referrer = moteur / social / webmail           → organic_search / *_social / email
 *   5. referrer externe non classé                    → referral
 *   5bis. `?ref=` parrainage interne (referral_code)  → referral
 *   6. is_direct / aucun signal                       → direct
 *   7. reste                                           → other
 *
 * La branche 5bis (parrainage interne) est volontairement placée APRÈS toute la
 * classification par referrer/utm et AVANT `direct` : un parrainage qui s'ajoute
 * à un vrai signal d'acquisition (gclid, utm payant, referrer externe) NE MASQUE
 * PAS ce canal plus riche ; il ne récupère QUE du trafic qui serait sinon tombé
 * en `direct` (referrer vide + aucun utm). Zéro régression sur l'attribution
 * existante par design.
 */
export function deriveChannel(signals: ChannelSignals): ChannelResult {
  const idFrom = norm(signals.utm_id_from);
  const medium = norm(signals.utm_medium);
  const refDomain = norm(signals.referrer_domain);
  // Fallback domaine : si referrer_domain vide mais referrer présent, tente
  // d'extraire un hostname grossier (le handler parse déjà, ceci sécurise les
  // cas backfill / payloads partiels).
  const refRaw = norm(signals.referrer);

  // 1. Google Ads click id = signal le plus fort (paid search).
  if (PAID_SEARCH_CLICK_IDS.has(idFrom)) {
    return finalize('paid_search');
  }

  // 2/3. utm_medium explicite.
  if (medium) {
    if (PAID_MEDIUMS.has(medium)) {
      // paid + referrer/source social → paid_social, sinon paid_search.
      if (
        SOCIAL_MEDIUMS.has(medium) ||
        isSocialDomain(refDomain || refRaw) ||
        isSocialSource(norm(signals.utm_source))
      ) {
        return finalize('paid_social');
      }
      return finalize('paid_search');
    }
    if (SOCIAL_MEDIUMS.has(medium)) {
      return finalize(
        PAID_SOCIAL_MEDIUMS.has(medium) ? 'paid_social' : 'organic_social',
      );
    }
    if (EMAIL_MEDIUMS.has(medium)) {
      return finalize('email');
    }
    if (REFERRAL_MEDIUMS.has(medium)) {
      return finalize('referral');
    }
    if (ORGANIC_MEDIUMS.has(medium)) {
      return finalize('organic_search');
    }
  }

  // 4. Classification par domaine du referrer.
  const domain = refDomain || refRaw;
  if (domain) {
    if (isEmailDomain(domain)) return finalize('email');
    if (isSearchEngineDomain(domain)) return finalize('organic_search');
    if (isSocialDomain(domain)) return finalize('organic_social');
    // 5. Referrer externe non classé.
    return finalize('referral');
  }

  // 5bis. Parrainage interne `?ref=<code>` (referral_code parsé en amont). On
  //       n'arrive ici QUE si aucun click id, aucun utm explicite et aucun
  //       referrer (externe) n'a matché — donc ce trafic serait sinon `direct`.
  //       Un code parrain non vide le récupère en `referral` (acquisition la
  //       plus rentable : virale, dérivée d'un lead payant). Conservateur par
  //       construction : il ne peut jamais écraser un canal classé plus haut.
  if (norm(signals.referral_code)) {
    return finalize('referral');
  }

  // 6. Direct (aucun referrer / is_direct).
  if (signals.is_direct || (!domain && !medium)) {
    return finalize('direct');
  }

  // 7. Reste.
  return finalize('other');
}

function finalize(channel: Channel): ChannelResult {
  return { channel, channel_group: toChannelGroup(channel) };
}

function isSearchEngineDomain(domain: string): boolean {
  return domainMatches(domain, SEARCH_ENGINE_DOMAINS);
}
function isSocialDomain(domain: string): boolean {
  return domainMatches(domain, SOCIAL_DOMAINS);
}
function isEmailDomain(domain: string): boolean {
  return domainMatches(domain, EMAIL_DOMAINS);
}
/** utm_source ressemblant à un réseau social (sans referrer fiable). */
function isSocialSource(source: string): boolean {
  if (!source) return false;
  return [
    'facebook',
    'instagram',
    'linkedin',
    'twitter',
    'x',
    'tiktok',
    'youtube',
    'pinterest',
    'snapchat',
    'reddit',
    'threads',
  ].some((s) => source === s || source.includes(s));
}
