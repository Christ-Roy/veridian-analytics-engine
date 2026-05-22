#!/usr/bin/env -S npx tsx
/**
 * migration-diff-alert.ts — alerte Telegram si l'écart dual-tracking dérape.
 *
 * Ticket D2 §Alerting : cron quotidien. Si l'écart pageviews legacy/staminads
 * dépasse 10 % pendant 3 jours consécutifs sur un tenant → message Telegram.
 *
 * Entrée : un fichier JSON de séries de diff produit par le job qui collecte
 * les pageviews des 2 stacks (dashboard /admin/migration-diff côté legacy, ou
 * un export). Format attendu :
 *
 *   [
 *     { "tenant": "avse-monetique",
 *       "points": [
 *         { "date": "2026-05-20", "pageviewsLegacy": 50, "pageviewsStaminads": 49 },
 *         ...
 *       ] }
 *   ]
 *
 * La logique de seuil est dans `lib/diff-alert.ts` (pure, testée).
 *
 * Variables d'environnement :
 *   MIGRATION_DIFF_FILE  — chemin du JSON de séries de diff (requis)
 *   TELEGRAM_BOT_TOKEN   — token bot (optionnel : si absent, log only)
 *   TELEGRAM_CHAT_ID     — chat cible (optionnel)
 *
 * Usage :
 *   MIGRATION_DIFF_FILE=/tmp/diff.json npx tsx scripts/migration/migration-diff-alert.ts
 *   # dry-run (n'envoie pas, affiche seulement) :
 *   npx tsx scripts/migration/migration-diff-alert.ts            # dry-run par défaut
 *   npx tsx scripts/migration/migration-diff-alert.ts --apply    # envoie réellement
 */

import { readDumpFile } from "./lib/dump-io.js";
import {
  tenantsToAlert,
  buildAlertMessage,
  type TenantDiffSeries,
} from "./lib/diff-alert.js";
import { parseFlags, makeLogger, modeBanner } from "./lib/cli.js";

const log = makeLogger("migration-diff-alert");

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log.warn(
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents — alerte non envoyée (log only).",
    );
    return;
  }
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    },
  );
  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status}`);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  log.info(modeBanner(flags));

  const diffFile = process.env.MIGRATION_DIFF_FILE;
  if (!diffFile) {
    log.error("MIGRATION_DIFF_FILE requis (chemin du JSON de séries de diff)");
    process.exit(1);
  }

  const series = readDumpFile<TenantDiffSeries>(diffFile);
  log.info(`${series.length} tenant(s) à évaluer`);

  const alerts = tenantsToAlert(series);
  const message = buildAlertMessage(alerts);

  if (alerts.length === 0) {
    log.ok("Aucun tenant en dépassement. Pas d'alerte.");
    return;
  }

  log.warn(`${alerts.length} tenant(s) en alerte :`);
  console.log(message);

  if (flags.dryRun) {
    log.info("Dry-run — alerte NON envoyée. Relancer avec --apply.");
    return;
  }
  await sendTelegram(message);
  log.ok("Alerte Telegram envoyée.");
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
