export const APP_VERSION = '11.0.0';
export const APP_MAJOR_VERSION = 11;

/**
 * SHA du commit déployé, injecté au build Docker (ARG/ENV GIT_SHA depuis
 * GITHUB_SHA en CI). Exposé dans /api/health.gitSha pour que le verdict de
 * deploy prod confirme que LE BON code est servi (pas juste un code sain).
 * 'unknown' en build local / hors-CI.
 */
export const GIT_SHA = process.env.GIT_SHA ?? 'unknown';
