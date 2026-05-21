/**
 * Shadow marketing : table centralisée des textes vendeurs pour les services
 * non actifs chez un client.
 *
 * Port direct du legacy `veridian-analytics/lib/shadow-marketing.ts` adapté
 * au bridge → staminads. Sert au front (dashboard tenant) qui affiche les
 * blocks "service non actif comme pub passive avec CTA upsell" en se basant
 * sur `inactiveServices` retourné par `GET /api/admin/tenant/:id/status` (A2).
 *
 * Différence vs legacy :
 *   - `emailBodyTemplate` est ici une `string` avec placeholder `{{domain}}`
 *     (au lieu d'une fonction `(domain) => string`). Permet de servir la
 *     config statique en JSON via `GET /api/admin/shadow-marketing` sans
 *     perdre l'info à la sérialisation. Le front fait le remplacement
 *     `template.replace('{{domain}}', siteDomain)` au moment de construire
 *     le mailto.
 *   - Périmètre limité aux 6 services de `KNOWN_SERVICES` (`push` legacy
 *     non porté tant qu'il n'est pas dans le tenant-status).
 *
 * Les textes sont **copiés mot pour mot** du legacy validé en prod —
 * ne pas paraphraser sans accord Robert.
 */

import type { ServiceKey } from "./tenant-status.js";

export type ShadowIconKey =
  | "phone"
  | "inbox"
  | "line-chart"
  | "search"
  | "megaphone"
  | "gauge"
  | "bell";

export interface ShadowMarketingEntry {
  title: string;
  description: string;
  ctaLabel: string;
  emailSubject: string;
  /**
   * Template du corps d'email avec placeholder `{{domain}}` à remplacer
   * côté front par le domaine du site client.
   */
  emailBodyTemplate: string;
  icon: ShadowIconKey;
}

export const SHADOW_MARKETING: Record<ServiceKey, ShadowMarketingEntry> = {
  pageviews: {
    title: "Trackez le trafic de votre site",
    description:
      "Installez le tracker Veridian pour voir en temps reel qui visite votre site, d'ou vient le trafic et quelles pages convertissent. Aucune config technique, Robert pose le snippet pour vous.",
    ctaLabel: "Activer le tracking",
    emailSubject: "Veridian Analytics — activer le tracking site",
    emailBodyTemplate:
      "Bonjour Robert,\n\nJe souhaite activer le tracking Veridian sur {{domain}}.\nMerci de me confirmer les prochaines etapes.\n\n--\nEnvoye depuis mon dashboard Veridian",
    icon: "line-chart",
  },
  forms: {
    title: "Captez tous les leads de votre site",
    description:
      "Chaque formulaire soumis est un prospect chaud. Veridian capture automatiquement chaque demande de contact, vous notifie par email et garde un historique complet — plus aucun lead perdu dans les mails.",
    ctaLabel: "Activer le tracking formulaires",
    emailSubject: "Veridian Analytics — activer le suivi des formulaires",
    emailBodyTemplate:
      "Bonjour Robert,\n\nJe souhaite activer le tracking des formulaires de contact sur {{domain}}.\nMerci de me dire ce que vous avez besoin de moi pour taguer mes formulaires.\n\n--\nEnvoye depuis mon dashboard Veridian",
    icon: "inbox",
  },
  calls: {
    title: "Suivez vos appels telephoniques",
    description:
      "Chaque appel manque est un client perdu. Installez un numero dedie Veridian pour tracker d'ou viennent vos appels, combien vous en ratez, et quelles pages de votre site generent le plus de contacts. A partir de 15 EUR/mois.",
    ctaLabel: "Activer le call tracking",
    emailSubject: "Veridian Analytics — activer le call tracking",
    emailBodyTemplate:
      "Bonjour Robert,\n\nJe souhaite activer le suivi des appels telephoniques pour {{domain}}.\nMerci de me proposer un numero dedie et de m'indiquer le cout mensuel.\n\n--\nEnvoye depuis mon dashboard Veridian",
    icon: "phone",
  },
  gsc: {
    title: "Decouvrez sur quels mots-cles Google vous trouve",
    description:
      "Connectez votre Google Search Console a Veridian pour voir chaque jour sur quelles requetes vous ressortez, vos positions, et vos clics reels. Indispensable pour comprendre votre SEO et reperer les pages a pousser.",
    ctaLabel: "Connecter Google Search Console",
    emailSubject: "Veridian Analytics — brancher Google Search Console",
    emailBodyTemplate:
      "Bonjour Robert,\n\nJe souhaite brancher ma Google Search Console a Veridian pour {{domain}}.\nMerci de me dire comment vous ajouter en acces a ma propriete GSC.\n\n--\nEnvoye depuis mon dashboard Veridian",
    icon: "search",
  },
  ads: {
    title: "Multipliez vos conversions avec Google Ads",
    description:
      "Une campagne Google Ads bien ciblee peut doubler votre volume de leads en 30 jours. Veridian gere la creation, le suivi et l'optimisation de votre campagne, avec les resultats remontes directement ici dans votre dashboard.",
    ctaLabel: "Lancer une campagne Google Ads",
    emailSubject: "Veridian Analytics — lancer une campagne Google Ads",
    emailBodyTemplate:
      "Bonjour Robert,\n\nJe suis interesse pour lancer une campagne Google Ads sur {{domain}}.\nMerci de me rappeler pour discuter du budget et des objectifs.\n\n--\nEnvoye depuis mon dashboard Veridian",
    icon: "megaphone",
  },
  pagespeed: {
    title: "Accelerez votre site et gagnez en conversion",
    description:
      "Un site lent, c'est jusqu'a 50% de visiteurs qui repartent avant meme d'avoir vu votre page. Veridian audite chaque semaine les performances de votre site et fournit un plan d'actions concret pour gagner en vitesse.",
    ctaLabel: "Activer le monitoring PageSpeed",
    emailSubject: "Veridian Analytics — activer le monitoring PageSpeed",
    emailBodyTemplate:
      "Bonjour Robert,\n\nJe souhaite activer le monitoring de vitesse de site pour {{domain}}.\nMerci de me donner les details du service.\n\n--\nEnvoye depuis mon dashboard Veridian",
    icon: "gauge",
  },
};
