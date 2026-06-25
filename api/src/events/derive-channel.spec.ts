import { deriveChannel, ChannelSignals } from './derive-channel';

type Case = {
  name: string;
  in: ChannelSignals;
  channel: string;
  group: string;
};

const cases: Case[] = [
  // ── Paid search (Google Ads click ids) ──────────────────────────────────
  {
    name: 'gclid → paid_search/ads',
    in: { utm_id_from: 'gclid', referrer_domain: 'google.com' },
    channel: 'paid_search',
    group: 'ads',
  },
  {
    name: 'gbraid → paid_search/ads',
    in: { utm_id_from: 'gbraid' },
    channel: 'paid_search',
    group: 'ads',
  },
  {
    name: 'wbraid → paid_search/ads',
    in: { utm_id_from: 'wbraid' },
    channel: 'paid_search',
    group: 'ads',
  },
  {
    name: 'utm_medium=cpc → paid_search/ads',
    in: { utm_medium: 'cpc', utm_source: 'google' },
    channel: 'paid_search',
    group: 'ads',
  },
  {
    name: 'utm_medium=ppc → paid_search/ads',
    in: { utm_medium: 'ppc' },
    channel: 'paid_search',
    group: 'ads',
  },
  // ── Organic search ──────────────────────────────────────────────────────
  {
    name: 'referrer google.com sans gclid → organic_search/seo',
    in: { referrer_domain: 'google.com', referrer: 'https://google.com/' },
    channel: 'organic_search',
    group: 'seo',
  },
  {
    name: 'referrer google.fr → organic_search/seo (France-aware)',
    in: { referrer_domain: 'www.google.fr' },
    channel: 'organic_search',
    group: 'seo',
  },
  {
    name: 'referrer bing.com → organic_search/seo',
    in: { referrer_domain: 'bing.com' },
    channel: 'organic_search',
    group: 'seo',
  },
  {
    name: 'referrer qwant.com → organic_search/seo (FR)',
    in: { referrer_domain: 'qwant.com' },
    channel: 'organic_search',
    group: 'seo',
  },
  {
    name: 'referrer duckduckgo.com → organic_search/seo',
    in: { referrer_domain: 'duckduckgo.com' },
    channel: 'organic_search',
    group: 'seo',
  },
  {
    name: 'utm_medium=organic → organic_search/seo',
    in: { utm_medium: 'organic', utm_source: 'google' },
    channel: 'organic_search',
    group: 'seo',
  },
  // ── Paid / organic social ───────────────────────────────────────────────
  {
    name: 'utm_medium=paid_social → paid_social/social',
    in: { utm_medium: 'paid_social', utm_source: 'facebook' },
    channel: 'paid_social',
    group: 'social',
  },
  {
    name: 'cpc + referrer facebook → paid_social/social',
    in: { utm_medium: 'cpc', referrer_domain: 'facebook.com' },
    channel: 'paid_social',
    group: 'social',
  },
  {
    name: 'utm_medium=social → organic_social/social',
    in: { utm_medium: 'social' },
    channel: 'organic_social',
    group: 'social',
  },
  {
    name: 'referrer linkedin.com → organic_social/social',
    in: { referrer_domain: 'linkedin.com' },
    channel: 'organic_social',
    group: 'social',
  },
  {
    name: 'referrer x.com (Twitter) → organic_social/social',
    in: { referrer_domain: 'x.com' },
    channel: 'organic_social',
    group: 'social',
  },
  {
    name: 'referrer t.co (Twitter shortener) → organic_social/social',
    in: { referrer_domain: 't.co' },
    channel: 'organic_social',
    group: 'social',
  },
  {
    name: 'referrer instagram.com → organic_social/social',
    in: { referrer_domain: 'l.instagram.com' },
    channel: 'organic_social',
    group: 'social',
  },
  // ── Email ───────────────────────────────────────────────────────────────
  {
    name: 'utm_medium=email → email/email',
    in: { utm_medium: 'email', utm_source: 'newsletter' },
    channel: 'email',
    group: 'email',
  },
  {
    name: 'utm_medium=newsletter → email/email',
    in: { utm_medium: 'newsletter' },
    channel: 'email',
    group: 'email',
  },
  {
    name: 'referrer mail.google.com → email/email',
    in: { referrer_domain: 'mail.google.com' },
    channel: 'email',
    group: 'email',
  },
  {
    name: 'referrer outlook.live.com → email/email',
    in: { referrer_domain: 'outlook.live.com' },
    channel: 'email',
    group: 'email',
  },
  // ── Referral ────────────────────────────────────────────────────────────
  {
    name: 'referrer externe non classé → referral/referral',
    in: { referrer_domain: 'lemonde.fr' },
    channel: 'referral',
    group: 'referral',
  },
  {
    name: 'utm_medium=referral → referral/referral',
    in: { utm_medium: 'referral', utm_source: 'partenaire' },
    channel: 'referral',
    group: 'referral',
  },
  {
    name: 'utm_medium=affiliate → referral/referral',
    in: { utm_medium: 'affiliate' },
    channel: 'referral',
    group: 'referral',
  },
  // ── Direct ──────────────────────────────────────────────────────────────
  {
    name: 'pas de referrer ni utm → direct/direct',
    in: { is_direct: true },
    channel: 'direct',
    group: 'direct',
  },
  {
    name: 'is_direct explicite + champs vides → direct/direct',
    in: { referrer: '', referrer_domain: '', utm_medium: '', is_direct: true },
    channel: 'direct',
    group: 'direct',
  },
  {
    name: 'tout vide → direct/direct',
    in: {},
    channel: 'direct',
    group: 'direct',
  },
  // ── Priorité : gclid l'emporte sur le referrer ──────────────────────────
  {
    name: 'gclid + referrer facebook → paid_search/ads (click id prioritaire)',
    in: { utm_id_from: 'gclid', referrer_domain: 'facebook.com' },
    channel: 'paid_search',
    group: 'ads',
  },
  // ── Priorité : utm_medium l'emporte sur le referrer ─────────────────────
  {
    name: 'utm_medium=email + referrer google → email (utm prioritaire)',
    in: { utm_medium: 'email', referrer_domain: 'google.com' },
    channel: 'email',
    group: 'email',
  },
  // ── Parrainage interne ?ref= (branche 5bis : récupère du direct) ─────────
  {
    name: 'referral_code seul (sinon direct) → referral/referral',
    in: { referral_code: 'VHCRPP6X', is_direct: true },
    channel: 'referral',
    group: 'referral',
  },
  {
    name: 'referral_code + aucun autre signal → referral/referral',
    in: { referral_code: 'ABC123' },
    channel: 'referral',
    group: 'referral',
  },
  // ── Conservatisme : le parrainage NE MASQUE JAMAIS un canal plus riche ───
  {
    name: 'referral_code + gclid → paid_search (click id prime)',
    in: { referral_code: 'VHCRPP6X', utm_id_from: 'gclid' },
    channel: 'paid_search',
    group: 'ads',
  },
  {
    name: 'referral_code + referrer google → organic_search (referrer prime)',
    in: { referral_code: 'VHCRPP6X', referrer_domain: 'google.com' },
    channel: 'organic_search',
    group: 'seo',
  },
  {
    name: 'referral_code + referrer externe → referral (referrer prime, même group)',
    in: { referral_code: 'VHCRPP6X', referrer_domain: 'lemonde.fr' },
    channel: 'referral',
    group: 'referral',
  },
  {
    name: 'referral_code + utm_medium=cpc → paid_search (utm payant prime)',
    in: { referral_code: 'VHCRPP6X', utm_medium: 'cpc' },
    channel: 'paid_search',
    group: 'ads',
  },
  {
    name: 'referral_code vide → direct (non régressif)',
    in: { referral_code: '', is_direct: true },
    channel: 'direct',
    group: 'direct',
  },
  {
    name: 'referral_code null → direct (non régressif)',
    in: { referral_code: null, is_direct: true },
    channel: 'direct',
    group: 'direct',
  },
];

describe('deriveChannel', () => {
  it.each(cases)('$name', (c) => {
    const result = deriveChannel(c.in);
    expect(result.channel).toBe(c.channel);
    expect(result.channel_group).toBe(c.group);
  });

  it('is case-insensitive on inputs', () => {
    expect(deriveChannel({ utm_medium: 'CPC' }).channel).toBe('paid_search');
    expect(deriveChannel({ referrer_domain: 'GOOGLE.COM' }).channel).toBe(
      'organic_search',
    );
  });

  it('trims whitespace on inputs', () => {
    expect(deriveChannel({ utm_id_from: '  gclid  ' }).channel).toBe(
      'paid_search',
    );
  });

  it('channel_group only ever takes aligned-with-phone_source values', () => {
    const allowed = new Set([
      'ads',
      'seo',
      'social',
      'email',
      'referral',
      'direct',
      'other',
    ]);
    for (const c of cases) {
      expect(allowed.has(deriveChannel(c.in).channel_group)).toBe(true);
    }
  });
});
