import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventBufferService } from '../events/event-buffer.service';
import { TrackingEvent } from '../events/entities/event.entity';
import { VoipService } from './voip.service';
import { fetchOvhCdr } from './providers/ovh';
import { fetchTelnyxCdr } from './providers/telnyx';
import { OvhCreds, TelnyxCreds } from './voip.providers';
import { NormalizedCall, VoipCredentialKind } from './voip.types';
import { buildPhoneCallEvent } from './phone-call-event';
import { toE164 } from './phone-e164';

/**
 * Sync VoIP natif — remplace le cron GH Action `voip-sync-cron.yml` + le bridge.
 *
 * Toutes les 15 min (gated sur `VOIP_SYNC_ENABLED='true'`), pour chaque
 * credential VoIP actif :
 *   1. pull les CDR providers (OVH signé / Telnyx Bearer) sur une fenêtre,
 *   2. lookup `(workspace, toNumber)→source` (1 numéro = 1 source),
 *   3. pousse chaque appel comme event goal `phone_call` EN INTERNE via
 *      `EventBufferService` (pas d'aller-retour HTTP `/api/track`).
 *
 * Pas de table `SipCall` : ClickHouse `events` est l'unique source de vérité.
 * Idempotence via `dedup_token` natif staminads (re-sync écrase, ne duplique
 * pas) — la fenêtre de pull peut donc chevaucher sans risque de doublon.
 */
@Injectable()
export class VoipSyncService {
  private readonly logger = new Logger(VoipSyncService.name);
  /** Fenêtre de pull par défaut quand aucune synchro précédente. */
  private readonly defaultLookbackDays = 7;
  /** Re-pull les 2 derniers jours à chaque run (recouvrement = idempotent). */
  private readonly overlapDays = 2;
  private running = false;

  constructor(
    private readonly voip: VoipService,
    private readonly events: EventBufferService,
    private readonly config: ConfigService,
  ) {}

  private enabled(): boolean {
    return this.config.get<string>('VOIP_SYNC_ENABLED') === 'true';
  }

  @Cron('0 */15 * * * *')
  async scheduledSync(): Promise<void> {
    if (!this.enabled()) return;
    await this.syncAll();
  }

  /**
   * Pull + push pour TOUS les credentials actifs. Idempotent, à l'épreuve d'un
   * provider qui plante (un échec n'arrête pas les autres).
   * Renvoie le total d'events poussés (utile pour un déclenchement manuel/test).
   */
  async syncAll(): Promise<{ syncedWorkspaces: number; pushedEvents: number }> {
    if (this.running) {
      this.logger.warn('VoIP sync already running, skipping overlap.');
      return { syncedWorkspaces: 0, pushedEvents: 0 };
    }
    this.running = true;
    let pushedEvents = 0;
    let syncedWorkspaces = 0;
    try {
      const creds = await this.voip.findAllActiveCredentials();
      this.logger.log(`VoIP sync: ${creds.length} active credential(s).`);
      for (const c of creds) {
        try {
          const n = await this.syncOne(c.workspaceId, c.kind, c.creds);
          pushedEvents += n;
          syncedWorkspaces++;
          await this.voip.markSynced(c.workspaceId, c.kind);
        } catch (err) {
          const msg = (err as Error).message;
          this.logger.error(
            `VoIP sync failed ws=${c.workspaceId} kind=${c.kind}: ${msg}`,
          );
          await this.voip.markSyncError(c.workspaceId, c.kind, msg);
        }
      }
    } finally {
      this.running = false;
    }
    this.logger.log(
      `VoIP sync done: ${pushedEvents} event(s) pushed across ${syncedWorkspaces} credential(s).`,
    );
    return { syncedWorkspaces, pushedEvents };
  }

  /** Pull + push pour UN credential. Renvoie le nombre d'events poussés. */
  async syncOne(
    workspaceId: string,
    kind: VoipCredentialKind,
    creds: OvhCreds | TelnyxCreds,
  ): Promise<number> {
    const since = new Date(
      Date.now() - this.lookbackDays() * 24 * 60 * 60 * 1000,
    );
    const calls = await this.pull(kind, creds, since);
    if (calls.length === 0) return 0;

    const lookup = await this.voip.buildSourceLookup(workspaceId);
    const provider = this.voip.providerOf(kind);
    const batch: TrackingEvent[] = [];
    for (const call of calls) {
      const e164 = toE164(call.toNumber);
      const match = e164 ? (lookup.get(e164) ?? null) : null;
      batch.push(buildPhoneCallEvent(workspaceId, provider, call, match));
    }
    await this.events.addBatch(batch);
    // Flush immédiat : un sync cron n'a pas vocation à laisser traîner les
    // events dans le buffer en attendant le timer 2s.
    await this.events.flush(workspaceId);
    this.logger.log(
      `VoIP sync ws=${workspaceId} kind=${kind}: ${batch.length} call(s) pushed.`,
    );
    return batch.length;
  }

  private lookbackDays(): number {
    // Fenêtre = max(overlap, defaultLookback). En l'absence d'un curseur
    // précis par cred, on re-pull une fenêtre fixe — l'idempotence dedup_token
    // absorbe le recouvrement.
    return Math.max(this.overlapDays, this.defaultLookbackDays);
  }

  private pull(
    kind: VoipCredentialKind,
    creds: OvhCreds | TelnyxCreds,
    since: Date,
  ): Promise<NormalizedCall[]> {
    if (kind === 'voip_ovh') {
      return fetchOvhCdr(creds as OvhCreds, { since });
    }
    return fetchTelnyxCdr(creds as TelnyxCreds, { since });
  }
}
