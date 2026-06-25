import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { EventBufferService } from './event-buffer.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { GeoService, GeoLocation } from '../geo';
import { Workspace } from '../workspaces/entities/workspace.entity';
import {
  SessionPayloadDto,
  PageviewActionDto,
  GoalActionDto,
  Action,
  isPageviewAction,
  isGoalAction,
} from './dto/session-payload.dto';
import { TrackingEvent } from './entities/event.entity';
import { toClickHouseDateTime } from '../common/utils/datetime.util';
import {
  extractFieldValues,
  applyFilterResults,
} from '../filters/lib/filter-evaluator';
import { deriveChannel } from './derive-channel';

export interface HandleResult {
  success: boolean;
}

// Workspace cache (same pattern as EventsService)
interface CachedWorkspace {
  workspace: Workspace;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000; // 1 minute cache
const CLOCK_SKEW_THRESHOLD_MS = 5000; // 5 seconds

@Injectable()
export class SessionPayloadHandler {
  private readonly logger = new Logger(SessionPayloadHandler.name);
  private workspaceCache = new Map<string, CachedWorkspace>();

  constructor(
    private readonly buffer: EventBufferService,
    private readonly workspacesService: WorkspacesService,
    private readonly geoService: GeoService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async handle(
    payload: SessionPayloadDto,
    clientIp: string | null,
    origin?: string,
    referer?: string,
  ): Promise<HandleResult> {
    // 1. Validate workspace
    const workspace = await this.getWorkspace(payload.workspace_id);

    // 1b. Kill-switch : ne PAS ingérer pour un workspace RÉELLEMENT inactif
    //     (résilié/suspendu = 'inactive', ou cassé = 'error'). Réponse 200 muette
    //     — comme le domain-reject plus bas — pour ne pas leaker l'état du tenant
    //     à un client externe. Le statut vient du cache workspace (TTL 60s) donc
    //     zéro coût DB additionnel à fort volume.
    //
    //     ⚠️ 'initializing' DOIT ingérer (P0 2026-06-24). Un workspace neuf est
    //     créé en 'initializing' (WorkspacesService.create) et n'a AUCUNE
    //     transition de sortie ailleurs. Le droppait ici (ancien `!== 'active'`)
    //     jetait son tout premier event → il ne devenait jamais 'active' →
    //     cercle vicieux mortel : 100 % du trafic d'un client provisionné
    //     normalement perdu en silence (incident Yoga Sculpt, argent client
    //     perdu). C'est précisément CE premier event valide qui flippe le
    //     workspace en 'active' (cf §11b plus bas).
    //
    //     On bloque donc UNIQUEMENT les états d'inactivité avérée, jamais
    //     l'amorçage. Ticket P0-killswitch-initializing-drop-ingestion 2026-06-24.
    if (workspace.status === 'inactive' || workspace.status === 'error') {
      this.logger.debug(
        `Ingestion skipped: workspace ${workspace.id} status=${workspace.status}`,
      );
      return { success: true };
    }

    // 2. Domain restriction (best-effort, NOT a security boundary).
    //    Origin/Referer come from the browser on real traffic, but are freely
    //    spoofable by curl/scripts — the previous "not spoofable" comment was
    //    wrong. New workspaces seed allowed_domains from their website at
    //    provisioning (see WorkspacesService.create), so the open default only
    //    affects legacy workspaces. When the list is empty we accept but warn,
    //    to surface workspaces still exposed to cross-workspace pollution.
    //    The real anti-flood rampart is infra rate-limiting (separate ticket).
    const requestDomain = this.extractRequestDomain(origin, referer);
    if (!workspace.settings.allowed_domains?.length) {
      this.logger.warn(
        `Domain check OPEN (allowed_domains empty) for workspace ${workspace.id} ` +
          `— accepting origin=${requestDomain || '<none>'}. Configure allowed_domains to close.`,
      );
    } else if (
      !this.isDomainAllowed(requestDomain, workspace.settings.allowed_domains)
    ) {
      this.logger.debug(
        `Domain rejected: ${requestDomain} for workspace ${workspace.id}`,
      );
      return { success: true };
    }

    // 3. Check for empty actions
    if (payload.actions.length === 0) {
      return { success: true };
    }

    // 4. Perform geo lookup once
    const geo = this.geoService.lookupWithSettings(clientIp, {
      geo_enabled: workspace.settings.geo_enabled,
      geo_store_city: workspace.settings.geo_store_city,
      geo_store_region: workspace.settings.geo_store_region,
      geo_coordinates_precision: workspace.settings.geo_coordinates_precision,
    });

    // 5. Set _version for all events (same timestamp for entire payload)
    const version = Date.now();

    // 6. Calculate clock skew
    const { skewMs, needsCorrection } = this.calculateClockSkew(
      payload.sent_at,
      version,
    );

    // 7. Build base event from session attributes (with skew correction).
    //    clientIp is captured SERVER-SIDE (never trusted from the payload) and
    //    stored IN CLEAR for B2B identification (decision Robert 2026-06-23).
    const baseEvent = this.buildBaseEvent(
      payload,
      geo,
      version,
      needsCorrection ? skewMs : 0,
      clientIp,
      workspace,
    );

    // 8. Deserialize actions to events
    const events: TrackingEvent[] = [];
    let previousPath = '';

    for (const action of payload.actions) {
      const event = this.deserializeAction(
        action,
        baseEvent,
        payload.session_id,
        previousPath,
        needsCorrection ? skewMs : 0,
      );
      events.push(event);

      // Update previous_path for next pageview
      if (isPageviewAction(action)) {
        previousPath = action.path;
      }
    }

    // 9. Apply filters if configured
    const filters = workspace.settings.filters ?? [];
    if (filters.length > 0) {
      for (const event of events) {
        this.applyFilters(event, filters);
      }
    }

    // 10. Add to buffer
    await this.buffer.addBatch(events);

    // 11. Fan-out webhooks (best-effort, never blocks ingestion).
    //     Cf todo/PATTERNS-WEBHOOKS.md §4.
    for (const event of events) {
      this.emitTracked(event);
    }

    // 11b. Transition initializing → active (P0 2026-06-24).
    //      Un workspace neuf naît 'initializing' (WorkspacesService.create) ; ce
    //      premier payload VALIDE prouve que le tracking est branché → on le
    //      passe 'active'. C'est la transition que le commentaire historique
    //      « Status remains 'initializing' until first event is received »
    //      promettait sans jamais l'implémenter.
    //
    //      Best-effort & NON bloquant : on N'AWAIT PAS (l'ingestion est déjà
    //      committée au buffer, l'event ne doit jamais dépendre de cette écriture
    //      système). Toute erreur est avalée — un échec de flip ne perd aucun
    //      event (le workspace reste 'initializing', qui ingère désormais aussi)
    //      et sera retenté au prochain payload. On invalide le cache local pour
    //      ne pas reflipper en boucle sur la fenêtre TTL.
    if (workspace.status === 'initializing') {
      this.activateWorkspace(workspace.id);
    }

    return { success: true };
  }

  /**
   * Flip a freshly-provisioned workspace out of the 'initializing' bootstrap
   * state into 'active' once its first valid payload has been ingested.
   * Fire-and-forget: never awaited
   * by the ingestion path, never throws into it.
   *
   * Idempotent: re-checks the status server-side inside
   * WorkspacesService.activateIfInitializing (a concurrent flip / a manual
   * activation is a no-op). The local cache is cleared so the next event reads
   * the fresh 'active' status instead of re-triggering this flip for the whole
   * TTL window.
   */
  private activateWorkspace(workspaceId: string): void {
    // Optimistically clear the cache NOW so concurrent in-flight events for the
    // same workspace don't each fire their own flip on the stale cached status.
    this.workspaceCache.delete(workspaceId);
    void this.workspacesService
      .activateIfInitializing(workspaceId)
      .then((flipped) => {
        if (flipped) {
          this.logger.log(
            `Workspace ${workspaceId} activated (first event ingested)`,
          );
        }
      })
      .catch((err) => {
        this.logger.warn(
          `activateWorkspace failed for ${workspaceId}: ${(err as Error).message} ` +
            `(workspace stays 'initializing' which still ingests; retried next event)`,
        );
      });
  }

  /**
   * Emit `event.tracked` for the webhooks dispatcher.
   * Errors here MUST never propagate to the ingestion pipeline.
   */
  private emitTracked(event: TrackingEvent): void {
    try {
      const rec = event as unknown as Record<string, unknown>;
      const payload = {
        workspace_id: event.workspace_id,
        event_type: event.name ?? 'unknown',
        // event_id MUST be STABLE for a given logical event so the Twenty
        // connector's deterministic id (f(personId, event_id, name)) collides
        // on replay = exactly-once (#12/#13). dedup_token is deterministic
        // (deserialize*: `${session_id}_pv_${page_number}` / `_goal_...`); the
        // fallback is ALSO deterministic (NO Date.now() — that would break
        // idempotence by making every replay a fresh id → duplicates).
        event_id:
          (rec.dedup_token as string | undefined) ||
          `${event.session_id}_${event.name}_${rec.page_number ?? 0}`,
        payload: {
          session_id: event.session_id,
          path: rec.path,
          page_number: rec.page_number,
          previous_path: rec.previous_path,
          // max_scroll drives the audit.scroll milestone (>=75) in the mapper.
          // Omitting it lost the scroll signal entirely (#15).
          max_scroll: rec.max_scroll,
          goal_name: rec.goal_name,
          goal_value: rec.goal_value,
          properties: rec.properties,
          utm: {
            source: rec.utm_source,
            medium: rec.utm_medium,
            campaign: rec.utm_campaign,
            term: rec.utm_term,
            content: rec.utm_content,
            id: rec.utm_id,
            id_from: rec.utm_id_from,
          },
          referrer: rec.referrer,
          referrer_domain: rec.referrer_domain,
          referrer_path: rec.referrer_path,
          landing_page: rec.landing_page,
          landing_domain: rec.landing_domain,
          landing_path: rec.landing_path,
          country: rec.country,
          region: rec.region,
          city: rec.city,
          device: rec.device,
          browser: rec.browser,
          os: rec.os,
          language: rec.language,
          timezone: rec.timezone,
          user_id: event.user_id ?? null,
          // Real event timestamps so the connector sets happensAt = TRUE event
          // time (§4c.2), not the write time. The mapper reads these (in order:
          // goal_timestamp → event_timestamp → entered_at → received_at). #15.
          goal_timestamp: rec.goal_timestamp,
          entered_at: rec.entered_at,
          received_at: rec.received_at,
        },
      };
      this.eventEmitter.emit('event.tracked', payload);
    } catch (err) {
      this.logger.warn(
        `emitTracked failed for ws=${event.workspace_id}: ${(err as Error).message}`,
      );
    }
  }

  private async getWorkspace(workspaceId: string): Promise<Workspace> {
    const now = Date.now();
    const cached = this.workspaceCache.get(workspaceId);

    if (cached && cached.expiresAt > now) {
      return cached.workspace;
    }

    try {
      const workspace = await this.workspacesService.get(workspaceId);
      this.workspaceCache.set(workspaceId, {
        workspace,
        expiresAt: now + CACHE_TTL_MS,
      });
      return workspace;
    } catch {
      throw new BadRequestException(`Invalid workspace_id: ${workspaceId}`);
    }
  }

  /**
   * Invalidate workspace cache (called when filters change).
   */
  @OnEvent('filters.changed')
  handleFiltersChanged(payload: { workspaceId: string }): void {
    this.workspaceCache.delete(payload.workspaceId);
  }

  /**
   * Invalidate workspace cache (called when workspace settings change).
   */
  @OnEvent('workspace.settings.changed')
  handleSettingsChanged(payload: { workspaceId: string }): void {
    this.workspaceCache.delete(payload.workspaceId);
  }

  private buildBaseEvent(
    payload: SessionPayloadDto,
    geo: GeoLocation,
    version: number,
    skewMs: number,
    clientIp: string | null,
    workspace: Workspace,
  ): Partial<TrackingEvent> {
    const attrs = payload.attributes;
    const now = toClickHouseDateTime();

    // Parse URLs for derived fields
    const referrerParsed = this.parseUrl(attrs?.referrer);
    const landingParsed = this.parseUrl(attrs?.landing_page);

    // Parrainage interne `?ref=<code>` (S6 Lot B). Parsé EN AMONT depuis la
    // landing page (deriveChannel reste pure) avec le param configurable
    // `settings.referral_param` (défaut `ref` ; vide/null = désactivé). Fail-soft
    // total : URL invalide / pas de query / param absent → code vide → canal
    // inchangé. Sert à récupérer du trafic sinon `direct` en `referral`, et à
    // garder QUI parraine dans `utm_content` (indépendamment du canal final).
    const referralCode = this.extractReferralCode(
      attrs?.landing_page,
      workspace.settings.referral_param,
    );

    // Derive acquisition channel (figé à l'ingestion) from the signals already
    // captured. channel = GA4-like fin ; channel_group = coarse aligné sur
    // phone_source pour la cohérence web↔appel. Cf derive-channel.ts (S1 du
    // chantier attribution). Sans ça channel/channel_group restent '' → filtre
    // et funnel par canal borgnes.
    const { channel, channel_group } = deriveChannel({
      referrer_domain: referrerParsed.domain,
      referrer: attrs?.referrer,
      utm_source: attrs?.utm_source,
      utm_medium: attrs?.utm_medium,
      utm_id_from: attrs?.utm_id_from,
      is_direct: !attrs?.referrer,
      referral_code: referralCode,
    });

    // Apply skew correction to session timestamps
    const correctedCreatedAt = skewMs
      ? this.correctTimestamp(payload.created_at, skewMs)
      : payload.created_at;
    const correctedUpdatedAt = skewMs
      ? this.correctTimestamp(payload.updated_at, skewMs)
      : payload.updated_at;

    return {
      session_id: payload.session_id,
      workspace_id: payload.workspace_id,
      received_at: now,
      created_at: toClickHouseDateTime(new Date(correctedCreatedAt)),
      updated_at: toClickHouseDateTime(new Date(correctedUpdatedAt)),
      _version: version,

      // Traffic source
      referrer: attrs?.referrer ?? '',
      referrer_domain: referrerParsed.domain ?? '',
      referrer_path: referrerParsed.path ?? '',
      is_direct: !attrs?.referrer,

      // Landing page
      landing_page: attrs?.landing_page ?? '',
      landing_domain: landingParsed.domain ?? '',
      landing_path: landingParsed.path ?? '',

      // UTM
      utm_source: attrs?.utm_source ?? '',
      utm_medium: attrs?.utm_medium ?? '',
      utm_campaign: attrs?.utm_campaign ?? '',
      utm_term: attrs?.utm_term ?? '',
      // Code parrain → utm_content (S6 Lot B), INDÉPENDAMMENT du canal final, dès
      // qu'un `?ref=` a été capté. À défaut, on conserve l'utm_content du SDK :
      // un parrainage sans utm n'écrase rien, et on ne le perd jamais quand il
      // est présent (utm_content est déjà colonne + dimension + export).
      utm_content: referralCode || attrs?.utm_content || '',
      utm_id: attrs?.utm_id ?? '',
      utm_id_from: attrs?.utm_id_from ?? '',

      // Device
      screen_width: attrs?.screen_width ?? 0,
      screen_height: attrs?.screen_height ?? 0,
      viewport_width: attrs?.viewport_width ?? 0,
      viewport_height: attrs?.viewport_height ?? 0,
      device: attrs?.device ?? '',
      browser: attrs?.browser ?? '',
      browser_type: attrs?.browser_type ?? '',
      os: attrs?.os ?? '',
      user_agent: attrs?.user_agent ?? '',
      connection_type: attrs?.connection_type ?? '',

      // Browser APIs
      language: attrs?.language ?? '',
      timezone: attrs?.timezone ?? '',

      // Geo
      country: geo.country ?? '',
      region: geo.region ?? '',
      city: geo.city ?? '',
      latitude: geo.latitude,
      longitude: geo.longitude,

      // SDK
      sdk_version: payload.sdk_version ?? '',

      // Acquisition channel derived at ingestion (cf derive-channel.ts).
      channel,
      channel_group,

      // Custom dimensions from SDK payload (default to empty string)
      stm_1: payload.dimensions?.stm_1 ?? '',
      stm_2: payload.dimensions?.stm_2 ?? '',
      stm_3: payload.dimensions?.stm_3 ?? '',
      stm_4: payload.dimensions?.stm_4 ?? '',
      stm_5: payload.dimensions?.stm_5 ?? '',
      stm_6: payload.dimensions?.stm_6 ?? '',
      stm_7: payload.dimensions?.stm_7 ?? '',
      stm_8: payload.dimensions?.stm_8 ?? '',
      stm_9: payload.dimensions?.stm_9 ?? '',
      stm_10: payload.dimensions?.stm_10 ?? '',

      // User identification (null if not provided or explicitly null)
      user_id: payload.user_id ?? null,

      // B2B identification (decision Robert 2026-06-23). visitor_id =
      // stable cross-session identity (SDK); fingerprint = device hash (SDK);
      // ip = client IP captured server-side, stored IN CLEAR (no hash/salt).
      visitor_id: payload.visitor_id ?? '',
      fingerprint: attrs?.fingerprint ?? '',
      ip: clientIp ?? '',
    };
  }

  private deserializeAction(
    action: Action,
    baseEvent: Partial<TrackingEvent>,
    sessionId: string,
    previousPath: string,
    skewMs: number,
  ): TrackingEvent {
    if (isPageviewAction(action)) {
      return this.deserializePageview(
        action,
        baseEvent,
        sessionId,
        previousPath,
        skewMs,
      );
    } else if (isGoalAction(action)) {
      return this.deserializeGoal(action, baseEvent, sessionId, skewMs);
    }

    // Unknown action type
    throw new BadRequestException(
      `Unknown action type: ${(action as { type: string }).type}`,
    );
  }

  private deserializePageview(
    action: PageviewActionDto,
    baseEvent: Partial<TrackingEvent>,
    sessionId: string,
    previousPath: string,
    skewMs: number,
  ): TrackingEvent {
    // Apply skew correction to pageview timestamps
    const correctedEnteredAt = skewMs
      ? this.correctTimestamp(action.entered_at, skewMs)
      : action.entered_at;
    const correctedExitedAt = skewMs
      ? this.correctTimestamp(action.exited_at, skewMs)
      : action.exited_at;

    return {
      ...baseEvent,
      dedup_token: `${sessionId}_pv_${action.page_number}`,
      name: 'screen_view',
      path: action.path,
      page_number: action.page_number,
      duration: action.duration, // NOT corrected - relative time
      page_duration: action.duration, // NOT corrected - relative time
      max_scroll: action.scroll,
      previous_path: previousPath,
      goal_name: '',
      goal_value: 0,
      properties: {},
      // SDK timestamps (corrected for clock skew)
      entered_at: toClickHouseDateTime(new Date(correctedEnteredAt)),
      exited_at: toClickHouseDateTime(new Date(correctedExitedAt)),
      goal_timestamp: null, // Not applicable for pageviews
    } as TrackingEvent;
  }

  private deserializeGoal(
    action: GoalActionDto,
    baseEvent: Partial<TrackingEvent>,
    sessionId: string,
    skewMs: number,
  ): TrackingEvent {
    // Apply skew correction to goal timestamp
    const correctedTimestamp = skewMs
      ? this.correctTimestamp(action.timestamp, skewMs)
      : action.timestamp;

    return {
      ...baseEvent,
      // Use ORIGINAL timestamp in dedup_token for consistency across retries
      dedup_token: `${sessionId}_goal_${action.name}_${action.timestamp}`,
      name: 'goal',
      path: action.path,
      page_number: action.page_number,
      duration: 0,
      page_duration: 0,
      max_scroll: 0,
      previous_path: '',
      goal_name: action.name,
      goal_value: action.value ?? 0,
      properties: action.properties ?? {},
      // SDK timestamps - use goal timestamp for non-applicable fields
      entered_at: toClickHouseDateTime(new Date(correctedTimestamp)),
      exited_at: toClickHouseDateTime(new Date(correctedTimestamp)),
      goal_timestamp: toClickHouseDateTime(new Date(correctedTimestamp)),
    } as TrackingEvent;
  }

  private parseUrl(urlString: string | undefined): {
    domain: string | null;
    path: string | null;
  } {
    if (!urlString) return { domain: null, path: null };
    try {
      const url = new URL(urlString);
      return { domain: url.hostname, path: url.pathname };
    } catch {
      return { domain: null, path: null };
    }
  }

  /**
   * Extrait le code de parrainage interne `?ref=<code>` de la landing page
   * (S6 Lot B). Tout est fail-soft — un échec ne renvoie jamais d'erreur dans
   * l'ingestion, juste une chaîne vide qui laisse le canal inchangé :
   *
   *   - `referralParam` absent / undefined → défaut `'ref'`
   *   - `referralParam` vide ('') ou null  → feature DÉSACTIVÉE (renvoie '')
   *   - landing_page absente / pas une URL valide / sans query string / param
   *     absent → renvoie '' (le visiteur n'a pas de code parrain)
   *
   * Le code est trimmé (les valeurs de querystring sont déjà URL-decodées par
   * URLSearchParams). On ne valide PAS le format du code ici : c'est un signal
   * d'acquisition opaque, propre à chaque client.
   */
  private extractReferralCode(
    landingPage: string | undefined,
    referralParam: string | null | undefined,
  ): string {
    // Désactivé explicitement : '' ou null. `undefined` ⇒ défaut 'ref'.
    if (referralParam === '' || referralParam === null) return '';
    const param = (referralParam ?? 'ref').trim();
    if (!param) return '';
    if (!landingPage) return '';
    try {
      const url = new URL(landingPage);
      return (url.searchParams.get(param) ?? '').trim();
    } catch {
      return '';
    }
  }

  private applyFilters(
    event: TrackingEvent,
    filters: Workspace['settings']['filters'],
  ): void {
    if (!filters || filters.length === 0) return;

    const eventRecord = event as unknown as Record<string, unknown>;
    const fieldValues = extractFieldValues(eventRecord);
    const { customDimensions, modifiedFields } = applyFilterResults(
      filters,
      fieldValues,
      eventRecord,
    );

    Object.assign(event, customDimensions);

    for (const [field, value] of Object.entries(modifiedFields)) {
      if (field === 'is_direct') {
        eventRecord[field] = value === 'true';
      } else {
        eventRecord[field] = value;
      }
    }
  }

  /**
   * Calculate clock skew between client and server.
   * Returns skew in milliseconds and whether correction is needed.
   */
  private calculateClockSkew(
    sentAt: number | undefined,
    receivedAtMs: number,
  ): { skewMs: number; needsCorrection: boolean } {
    if (sentAt === undefined) {
      return { skewMs: 0, needsCorrection: false }; // Legacy SDK
    }

    const skewMs = receivedAtMs - sentAt;

    // Negative skew (client ahead) - ALWAYS wrong, must correct
    if (skewMs < -CLOCK_SKEW_THRESHOLD_MS) {
      return { skewMs, needsCorrection: true };
    }

    // Positive skew beyond threshold (client behind) - must correct
    if (skewMs > CLOCK_SKEW_THRESHOLD_MS) {
      return { skewMs, needsCorrection: true };
    }

    return { skewMs, needsCorrection: false };
  }

  /**
   * Correct a timestamp by applying the clock skew delta.
   */
  private correctTimestamp(timestampMs: number, skewMs: number): number {
    return timestampMs + skewMs;
  }

  /**
   * Extract domain from Origin header, fallback to Referer.
   */
  private extractRequestDomain(origin?: string, referer?: string): string {
    if (origin) {
      try {
        return new URL(origin).hostname;
      } catch {
        // Invalid URL, fall through to referer
      }
    }
    if (referer) {
      try {
        return new URL(referer).hostname;
      } catch {
        // Invalid URL, return empty
      }
    }
    return '';
  }

  /**
   * Check if domain matches allowed list (with wildcard support).
   * Returns true if no restrictions configured or domain matches.
   */
  private isDomainAllowed(domain: string, allowedDomains?: string[]): boolean {
    // No restriction configured - allow all
    if (!allowedDomains?.length) {
      return true;
    }

    // No domain info + restrictions = reject
    if (!domain) {
      return false;
    }

    const normalized = domain.toLowerCase();

    for (const allowed of allowedDomains) {
      const pattern = allowed.toLowerCase().trim();

      if (pattern.startsWith('*.')) {
        // Wildcard: *.example.com matches sub.example.com and example.com
        const base = pattern.slice(2);
        if (normalized === base || normalized.endsWith('.' + base)) {
          return true;
        }
      } else if (normalized === pattern) {
        // Exact match
        return true;
      }
    }

    return false;
  }
}
