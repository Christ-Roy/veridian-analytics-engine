/**
 * Types partagés Veridian (port subset minimal de
 * `veridian-analytics/lib/tenant-status.ts` et `shadow-marketing.ts`).
 *
 * Pas de logique server-side ici — uniquement les types et la table
 * statique `SHADOW_MARKETING` consommée par les composants visuels.
 */

export const KNOWN_SERVICES = [
  'pageviews',
  'forms',
  'calls',
  'gsc',
  'ads',
  'pagespeed',
  'push',
] as const;

export type ServiceKey = (typeof KNOWN_SERVICES)[number];

export type ShadowIconKey =
  | 'phone'
  | 'inbox'
  | 'line-chart'
  | 'search'
  | 'megaphone'
  | 'gauge'
  | 'bell';

export interface ShadowMarketingEntry {
  title: string;
  description: string;
  ctaLabel: string;
  emailSubject: string;
  emailBodyTemplate: (siteDomain: string) => string;
  icon: ShadowIconKey;
}

export const SHADOW_MARKETING: Record<ServiceKey, ShadowMarketingEntry> = {
  pageviews: {
    title: 'Trackez le trafic de votre site',
    description:
      "Installez le tracker Veridian pour voir en temps reel qui visite votre site, d'ou vient le trafic et quelles pages convertissent. Aucune config technique, Robert pose le snippet pour vous.",
    ctaLabel: 'Activer le tracking',
    emailSubject: 'Veridian Analytics — activer le tracking site',
    emailBodyTemplate: (domain) =>
      `Bonjour Robert,\n\nJe souhaite activer le tracking Veridian sur ${domain}.\nMerci de me confirmer les prochaines etapes.\n\n--\nEnvoye depuis mon dashboard Veridian`,
    icon: 'line-chart',
  },
  forms: {
    title: 'Captez tous les leads de votre site',
    description:
      'Chaque formulaire soumis est un prospect chaud. Veridian capture automatiquement chaque demande de contact, vous notifie par email et garde un historique complet — plus aucun lead perdu dans les mails.',
    ctaLabel: 'Activer le tracking formulaires',
    emailSubject: 'Veridian Analytics — activer le suivi des formulaires',
    emailBodyTemplate: (domain) =>
      `Bonjour Robert,\n\nJe souhaite activer le tracking des formulaires de contact sur ${domain}.\nMerci de me dire ce que vous avez besoin de moi pour taguer mes formulaires.\n\n--\nEnvoye depuis mon dashboard Veridian`,
    icon: 'inbox',
  },
  calls: {
    title: 'Suivez vos appels telephoniques',
    description:
      "Chaque appel manque est un client perdu. Installez un numero dedie Veridian pour tracker d'ou viennent vos appels, combien vous en ratez, et quelles pages de votre site generent le plus de contacts. A partir de 15 EUR/mois.",
    ctaLabel: 'Activer le call tracking',
    emailSubject: 'Veridian Analytics — activer le call tracking',
    emailBodyTemplate: (domain) =>
      `Bonjour Robert,\n\nJe souhaite activer le suivi des appels telephoniques pour ${domain}.\nMerci de me proposer un numero dedie et de m'indiquer le cout mensuel.\n\n--\nEnvoye depuis mon dashboard Veridian`,
    icon: 'phone',
  },
  gsc: {
    title: 'Decouvrez sur quels mots-cles Google vous trouve',
    description:
      'Connectez votre Google Search Console a Veridian pour voir chaque jour sur quelles requetes vous ressortez, vos positions, et vos clics reels. Indispensable pour comprendre votre SEO et reperer les pages a pousser.',
    ctaLabel: 'Connecter Google Search Console',
    emailSubject: 'Veridian Analytics — brancher Google Search Console',
    emailBodyTemplate: (domain) =>
      `Bonjour Robert,\n\nJe souhaite brancher ma Google Search Console a Veridian pour ${domain}.\nMerci de me dire comment vous ajouter en acces a ma propriete GSC.\n\n--\nEnvoye depuis mon dashboard Veridian`,
    icon: 'search',
  },
  ads: {
    title: 'Multipliez vos conversions avec Google Ads',
    description:
      'Une campagne Google Ads bien ciblee peut doubler votre volume de leads en 30 jours. Veridian gere la creation, le suivi et l\'optimisation de votre campagne, avec les resultats remontes directement ici dans votre dashboard.',
    ctaLabel: 'Lancer une campagne Google Ads',
    emailSubject: 'Veridian Analytics — lancer une campagne Google Ads',
    emailBodyTemplate: (domain) =>
      `Bonjour Robert,\n\nJe suis interesse pour lancer une campagne Google Ads sur ${domain}.\nMerci de me rappeler pour discuter du budget et des objectifs.\n\n--\nEnvoye depuis mon dashboard Veridian`,
    icon: 'megaphone',
  },
  pagespeed: {
    title: 'Accelerez votre site et gagnez en conversion',
    description:
      "Un site lent, c'est jusqu'a 50% de visiteurs qui repartent avant meme d'avoir vu votre page. Veridian audite chaque semaine les performances de votre site et fournit un plan d'actions concret pour gagner en vitesse.",
    ctaLabel: 'Activer le monitoring PageSpeed',
    emailSubject: 'Veridian Analytics — activer le monitoring PageSpeed',
    emailBodyTemplate: (domain) =>
      `Bonjour Robert,\n\nJe souhaite activer le monitoring de vitesse de site pour ${domain}.\nMerci de me donner les details du service.\n\n--\nEnvoye depuis mon dashboard Veridian`,
    icon: 'gauge',
  },
  push: {
    title: 'Envoyez des notifications push a vos visiteurs',
    description:
      "Installez la PWA Veridian sur votre site pour que vos visiteurs puissent l'ajouter a leur ecran d'accueil. Envoyez-leur ensuite des notifications push (promotions, nouveautes, rappels) directement sur leur telephone.",
    ctaLabel: 'Activer les notifications push',
    emailSubject: 'Veridian Analytics — activer les notifications push',
    emailBodyTemplate: (domain) =>
      `Bonjour Robert,\n\nJe souhaite activer les notifications push pour ${domain}.\nMerci de me dire comment installer la PWA sur mon site.\n\n--\nEnvoye depuis mon dashboard Veridian`,
    icon: 'bell',
  },
};

/**
 * Construit un lien mailto pre-rempli pour un service donne.
 */
export function buildMailto(
  service: ServiceKey,
  siteDomain: string,
  contactEmail = 'contact@veridian.site',
): string {
  const entry = SHADOW_MARKETING[service];
  const subject = encodeURIComponent(entry.emailSubject);
  const body = encodeURIComponent(entry.emailBodyTemplate(siteDomain));
  return `mailto:${contactEmail}?subject=${subject}&body=${body}`;
}
