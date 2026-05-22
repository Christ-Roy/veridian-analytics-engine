/**
 * Helpers CLI partagés par les scripts de migration D2.
 *
 * - parsing des flags (--dry-run / --apply / --limit)
 * - logging horodaté préfixé
 * - garde "dry-run par défaut" : un script de migration ne doit JAMAIS
 *   écrire sans `--apply` explicite.
 */

export interface MigrationFlags {
  /** true sauf si --apply passé. Mode lecture seule, aucune écriture. */
  dryRun: boolean;
  /** limite optionnelle du nombre de rows traitées (debug). */
  limit: number | null;
  /** verbeux : log row par row. */
  verbose: boolean;
}

/**
 * Parse les flags. `--dry-run` est le DÉFAUT — il faut `--apply` explicite
 * pour écrire quoi que ce soit. Passer les deux → erreur.
 */
export function parseFlags(argv: string[]): MigrationFlags {
  const hasApply = argv.includes("--apply");
  const hasDryRun = argv.includes("--dry-run");
  if (hasApply && hasDryRun) {
    throw new Error("--apply et --dry-run sont mutuellement exclusifs");
  }
  let limit: number | null = null;
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  if (limitArg) {
    const n = Number(limitArg.split("=")[1]);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit invalide: ${limitArg}`);
    }
    limit = n;
  }
  return {
    // Sécurité : tout sauf --apply est un dry-run.
    dryRun: !hasApply,
    limit,
    verbose: argv.includes("--verbose") || argv.includes("-v"),
  };
}

/** Logger horodaté préfixé par le nom du script. */
export function makeLogger(scriptName: string) {
  const stamp = () => new Date().toISOString();
  return {
    info: (msg: string) => console.log(`[${scriptName}] ${stamp()} ${msg}`),
    warn: (msg: string) => console.warn(`[${scriptName}] ${stamp()} ⚠ ${msg}`),
    error: (msg: string) => console.error(`[${scriptName}] ${stamp()} ✗ ${msg}`),
    ok: (msg: string) => console.log(`[${scriptName}] ${stamp()} ✓ ${msg}`),
  };
}

/** Bannière mode dry-run / apply affichée au démarrage de chaque script. */
export function modeBanner(flags: MigrationFlags): string {
  return flags.dryRun
    ? "MODE DRY-RUN — aucune écriture. Relancer avec --apply pour exécuter."
    : "MODE APPLY — écritures RÉELLES en base.";
}
