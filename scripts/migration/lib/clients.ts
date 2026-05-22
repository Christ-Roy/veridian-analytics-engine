/**
 * Liste figée des 5 clients prod à migrer (ticket D2).
 *
 * Source : `veridian-core-db.analytics.Site` legacy. On la fige en dur ici
 * plutôt que de la lire dynamiquement pour 3 raisons :
 *   1. La migration est une opération ponctuelle, contrôlée — on veut savoir
 *      EXACTEMENT quels sites sont touchés, pas "tout ce que la DB renvoie".
 *   2. Le script de dry-run doit pouvoir tourner sans accès à la DB legacy.
 *   3. Les `legacySiteKey` doivent être confirmés AVANT la migration réelle
 *      (cf. CHECKLIST.md étape "résoudre les siteKey legacy").
 *
 * ⚠️ Les `legacySiteKey` ci-dessous sont des PLACEHOLDERS. Avant la vraie
 * migration, l'opérateur DOIT les remplacer par les vraies valeurs lues via :
 *
 *   psql "$LEGACY_DATABASE_URL" -c \
 *     "SELECT s.\"siteKey\", s.domain, t.slug
 *        FROM analytics.\"Site\" s
 *        JOIN analytics.\"Tenant\" t ON t.id = s.\"tenantId\"
 *       WHERE t.\"deletedAt\" IS NULL;"
 *
 * Le script `migrate-existing-tenants.ts` refuse de tourner en mode `--apply`
 * tant qu'un `legacySiteKey` vaut encore un placeholder `RESOLVE_*`.
 */

export interface ClientToMigrate {
  /** slug du tenant côté Veridian (= analytics.Tenant.slug legacy). */
  slug: string;
  /** domaine du site. */
  domain: string;
  /** siteKey legacy (analytics.Site.siteKey) — réutilisé comme Site.siteKey bridge. */
  legacySiteKey: string;
  /** hosting du site — détermine le mode de pose du snippet. */
  hosting: "veridian" | "external";
  /** pageviews 30j observés côté legacy (sanity check post-migration). */
  pageviews30d: number;
  /** contact pour les sites externes (email à router via Robert). */
  externalContact?: string;
}

/**
 * Sentinelle placeholder. Un `legacySiteKey` qui commence par cette valeur
 * n'a pas encore été résolu → le script bloque en mode `--apply`.
 */
export const SITEKEY_PLACEHOLDER_PREFIX = "RESOLVE_";

export const CLIENTS_TO_MIGRATE: ClientToMigrate[] = [
  {
    slug: "avse-monetique",
    domain: "avse-monetique.veridian.site",
    legacySiteKey: "RESOLVE_avse-monetique",
    hosting: "veridian",
    pageviews30d: 1504,
  },
  {
    slug: "morel-volailles-com",
    domain: "morel-volailles.com",
    legacySiteKey: "RESOLVE_morel-volailles-com",
    hosting: "veridian",
    pageviews30d: 674,
  },
  {
    slug: "robert-deboucheur",
    domain: "robert-deboucheur.fr",
    legacySiteKey: "RESOLVE_robert-deboucheur",
    hosting: "veridian",
    pageviews30d: 270,
  },
  {
    slug: "tramtech-depannage-fr",
    domain: "tramtech-depannage.fr",
    legacySiteKey: "RESOLVE_tramtech-depannage-fr",
    hosting: "external",
    pageviews30d: 87,
    externalContact: "Tramtech (via Robert)",
  },
  {
    slug: "arnaudcapitaine-com",
    domain: "arnaudcapitaine.com",
    legacySiteKey: "RESOLVE_arnaudcapitaine-com",
    hosting: "external",
    pageviews30d: 0,
    externalContact: "Arnaud Capitaine (via Robert)",
  },
];

/** True si le siteKey est encore un placeholder non résolu. */
export function isPlaceholderSiteKey(siteKey: string): boolean {
  return siteKey.startsWith(SITEKEY_PLACEHOLDER_PREFIX);
}

/** Liste des clients dont le siteKey n'est pas encore résolu. */
export function unresolvedClients(
  clients: ClientToMigrate[] = CLIENTS_TO_MIGRATE,
): ClientToMigrate[] {
  return clients.filter((c) => isPlaceholderSiteKey(c.legacySiteKey));
}
