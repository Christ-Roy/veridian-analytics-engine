import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { GscOauthService } from './gsc-oauth.service';
import { GscSyncService } from './gsc-sync.service';

/**
 * Cron natif de sync GSC — remplace la GitHub Action `gsc-sync-cron.yml`
 * (gated/désactivée) du bridge. Tourne dans le process engine, observable dans
 * ses logs, pas de workflow externe à maintenir.
 *
 * Fréquence : 1×/jour à 04:00 (GSC a ~2j de latence, inutile de syncer souvent).
 * On pull 7 jours glissants → re-écrit la fenêtre récente, idempotent
 * (ReplacingMergeTree). No-op si GSC n'est pas configuré sur l'instance.
 */
@Injectable()
export class GscSyncScheduler {
  private readonly logger = new Logger(GscSyncScheduler.name);

  constructor(
    private readonly sync: GscSyncService,
    private readonly oauth: GscOauthService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async syncAll(): Promise<void> {
    // Garde-fou : un agent peut désactiver le cron sans toucher au code.
    if (this.config.get<string>('GSC_SYNC_CRON_DISABLED') === 'true') {
      return;
    }
    if (!this.oauth.isConfigured()) {
      this.logger.debug('GSC not configured — skipping scheduled sync.');
      return;
    }
    this.logger.log('Starting scheduled GSC sync (verified properties)...');
    const results = await this.sync.syncAllVerified({ days: 7 });
    const upserted = results.reduce((acc, r) => acc + r.upserted, 0);
    const withErrors = results.filter((r) => r.errors.length > 0).length;
    this.logger.log(
      `GSC sync done: ${results.length} properties, ${upserted} rows upserted, ${withErrors} with errors.`,
    );
  }
}
