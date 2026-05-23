/**
 * Veridian Analytics — Brand constants
 *
 * Replaces hard-coded upstream Staminads links (docs.staminads.com,
 * github.com/staminads/staminads/issues) and version strings throughout
 * the console UI. See BUG-08/09/10/13.
 *
 * The Veridian fork ships under its own version line (see DISPLAY_VERSION)
 * which is intentionally decoupled from `api/src/version.ts` (the latter
 * drives DB schema migrations and SDK compatibility — we do NOT touch it
 * to avoid running a migration on existing tenants).
 */
export const BRAND = {
  name: 'Veridian Analytics',
  homepageUrl: 'https://veridian.site',
  docsUrl: 'https://veridian.site/docs/analytics',
  /** Issue-reporting endpoint: a mailto, not a public repo, to avoid leaking
   *  client setup/data into the upstream open-source tracker. */
  issuesUrl: 'mailto:robert.brunon@veridian.site?subject=Veridian%20Analytics%20-%20Report%20an%20issue',
} as const

/**
 * Version displayed in the user menu (`v{DISPLAY_VERSION}`).
 *
 * Decoupled from `__APP_VERSION__` (which is `api/src/version.ts` and drives
 * DB migrations + SDK compatibility checks). The latter must remain at the
 * upstream major (currently 6.x) because tenant DBs are pinned to it; bumping
 * it would trigger migrations on existing prod tenants.
 *
 * DISPLAY_VERSION reflects the Veridian fork's own release line and is safe
 * to bump without DB impact.
 */
export const DISPLAY_VERSION = '0.5.0'
