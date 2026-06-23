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
          const n = await this.syncOne(
            c.workspaceId,
            c.kind,
            c.creds,
            c.lastSyncAt,
          );
          pushedEvents += n;
          syncedWorkspaces++;
          await this.voip.markSynced(c.workspaceId, c.kind);
        } catch (err) {
          const msg = (err as Error).message;
          this.logger.error(
            `VoIP sync FAILED ws=${c.workspaceId} kind=${c.kind}: ${msg}`,
          );
          await this.voip.markSyncError(c.workspaceId, c.kind, msg);
        }
      }
    } catch (err) {
      // Garde-fou : toute exception inattendue (ex findAllActiveCredentials qui
      // throw) ne doit JAMAIS laisser `running` bloqué — le `finally` ci-dessous
      // s'en charge, mais on loggue clairement pour ne pas échouer en silence.
      this.logger.error(
        `VoIP sync run aborted unexpectedly: ${(err as Error).message}`,
      );
    } finally {
      // INVARIANT CRITIQUE : `running` revient TOUJOURS à false, même sur
      // timeout/exception d'un fetch provider. Couplé aux timeouts des
      // providers (AbortSignal.timeout), cela garantit qu'un incident réseau
      // côté provider ne gèle JAMAIS le module VoIP entier à vie.
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
    lastSyncAt: Date | null = null,
  ): Promise<number> {
    const since = this.computeSince(lastSyncAt);
    const calls = await this.pull(kind, creds, since);
    if (calls.length === 0) return 0;

    const lookup = await this.voip.buildSourceLookup(workspaceId);
    const provider = this.voip.providerOf(kind);
    const batch: TrackingEvent[] = [];
    // Visibilité attribution : on collecte les numéros appelés non mappés à une
    // source (vision "1 numéro = 1 source"). Ces appels sont quand même poussés
    // (attribués `direct` pour l'affichage + `source_attributed='false'`) mais
    // on remonte un WARN clair pour que Robert/le client sache qu'un numéro est
    // à configurer dans Settings → VoIP. Sinon l'attribution est borgne.
    const unmappedNumbers = new Set<string>();
    for (const call of calls) {
      const e164 = toE164(call.toNumber);
      const match = e164 ? (lookup.get(e164) ?? null) : null;
      if (!match) unmappedNumbers.add(e164 || call.toNumber || '(inconnu)');
      batch.push(buildPhoneCallEvent(workspaceId, provider, call, match));
    }
    await this.events.addBatch(batch);
    // Flush immédiat : un sync cron n'a pas vocation à laisser traîner les
    // events dans le buffer en attendant le timer 2s.
    await this.events.flush(workspaceId);
    this.logger.log(
      `VoIP sync ws=${workspaceId} kind=${kind}: ${batch.length} call(s) pushed.`,
    );
    if (unmappedNumbers.size > 0) {
      this.logger.warn(
        `VoIP sync ws=${workspaceId} kind=${kind}: ${unmappedNumbers.size} ` +
          `numéro(s) appelé(s) non mappé(s) à une source (attribués 'direct') ` +
          `→ à configurer dans Settings → VoIP : ${[...unmappedNumbers].join(', ')}`,
      );
    }
    return batch.length;
  }

  /**
   * Borne basse de pull incrémentale.
   *
   * `since = max(last_sync_at − overlap, now − defaultLookback)` :
   *   - jamais synchronisé (`lastSyncAt` null) → `now − defaultLookback` (7j,
   *     premier pull complet) ;
   *   - synchronisé récemment → repart de `last_sync_at − overlap` (recouvrement
   *     de 2j, idempotent via dedup_token) au lieu de re-pull 7j à chaque run
   *     (96×/jour). Économise massivement les appels API providers ;
   *   - `last_sync_at` vieux de >defaultLookback (cron resté off longtemps) → on
   *     plafonne au lookback par défaut pour ne pas pull une fenêtre démesurée.
   */
  private computeSince(lastSyncAt: Date | null): Date {
    const defaultFloor = new Date(
      Date.now() - this.defaultLookbackDays * 24 * 60 * 60 * 1000,
    );
    if (!lastSyncAt || Number.isNaN(lastSyncAt.getTime())) {
      return defaultFloor;
    }
    const incremental = new Date(
      lastSyncAt.getTime() - this.overlapDays * 24 * 60 * 60 * 1000,
    );
    // max(incremental, defaultFloor) : ne JAMAIS remonter plus loin que le
    // lookback par défaut, mais ne JAMAIS pull moins que l'overlap récent.
    return incremental.getTime() > defaultFloor.getTime()
      ? incremental
      : defaultFloor;
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
