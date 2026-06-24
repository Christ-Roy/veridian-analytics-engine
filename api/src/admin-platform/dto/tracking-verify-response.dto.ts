import { ApiProperty } from '@nestjs/swagger';

/**
 * Why a real /api/track probe was dropped, when it was. Mirrors the silent
 * 200-muted exits inside SessionPayloadHandler so an IA/CLI knows EXACTLY which
 * gate ate the event. /api/track always answers HTTP 200 even when it drops, so
 * `null` here means "the event came through", a non-null value names the gate
 * that swallowed it.
 */
export type TrackingDropReason =
  | 'workspace_inactive' // kill-switch: status inactive/error
  | 'domain_not_allowed' // Origin not in allowed_domains
  | 'validation_rejected' // DTO validation refused the payload (HTTP 400)
  | 'not_requeryable'; // accepted but never surfaced in CH within the timeout

/**
 * Result of the REAL ingestion probe: a genuine HTTP POST to /api/track — the
 * exact door real browser traffic hits (kill-switch + domain-check + DTO
 * validation + buffer + MV fan-out) — read back from ClickHouse and purged. The
 * synthetic event uses a reserved deterministic session_id, a far-past goal
 * timestamp (invisible to every date-bounded report) and is purged after the
 * probe — see AdminPlatformService.verifyTracking.
 */
export class TrackingVerifyIngestion {
  @ApiProperty({
    description:
      'True ONLY if a real HTTP POST to /api/track (the exact door real ' +
      'browser traffic hits — kill-switch + domain-check + DTO validation + ' +
      'buffer + MV fan-out included) was ingested and then re-read out of ' +
      'ClickHouse. This is the honest proof the live tracker chain works; it ' +
      'is NOT a side-channel insert.',
  })
  ok: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Round-trip latency (ms) between the HTTP POST and the event being ' +
      'requeryable. null when ingestion failed or was dropped.',
  })
  round_trip_ms: number | null;

  @ApiProperty({
    nullable: true,
    enum: [
      'workspace_inactive',
      'domain_not_allowed',
      'validation_rejected',
      'not_requeryable',
    ],
    description:
      'Which gate dropped the event, when ok=false. null when ok=true. ' +
      '/api/track answers 200 even when it silently drops, so this field is ' +
      'the only way to know WHY the real door ate the event.',
  })
  drop_reason?: TrackingDropReason | null;

  @ApiProperty({
    description:
      'True when the low-level table+MV insert chain (bypassing the HTTP ' +
      'door) succeeded. Lets an IA distinguish a healthy ClickHouse storage ' +
      'chain whose public door is dropping (a gate problem) versus a broken ' +
      'storage chain. Kept ALONGSIDE the HTTP probe.',
  })
  low_level_chain_ok: boolean;

  @ApiProperty({ description: 'Human-readable outcome of the ingestion probe.' })
  detail: string;
}

/** Snippet audit — only present when site_url was supplied. */
export class TrackingVerifySnippet {
  @ApiProperty({ description: 'Always true when this block is present.' })
  checked: boolean;

  @ApiProperty({
    description: 'True if a Veridian/staminads tracker <script> was found.',
  })
  present: boolean;

  @ApiProperty({
    description:
      'True if the script src points at /sdk/v1/tracker.js (the route that ' +
      'serves the real bundle), NOT the bare /tracker.js path which falls ' +
      'through to the SPA console HTML and tracks nothing.',
  })
  src_correct: boolean;

  @ApiProperty({
    description: 'True if data-workspace-id matches the requested workspace.',
  })
  workspace_id_match: boolean;

  @ApiProperty({ description: 'Human-readable outcome of the snippet probe.' })
  detail: string;
}

/** Real (non-synthetic) tracking liveness — reuses workspaces.status probe. */
export class TrackingVerifyRealTracking {
  @ApiProperty({ description: 'Real sessions recorded in the last 30 days.' })
  sessions_30d: number;

  @ApiProperty({
    description: 'True if a real session was recorded in the last 30 minutes.',
  })
  live: boolean;
}

export type TrackingVerifyVerdict =
  | 'ok'
  | 'ingestion_failed' // CH/storage chain broken (low-level probe failed too)
  | 'dropped_workspace_inactive' // real door dropped: workspace inactive/error
  | 'dropped_domain_not_allowed' // real door dropped: Origin not allowed
  | 'snippet_missing'
  | 'snippet_misconfigured'
  | 'workspace_not_found';

/**
 * Response of POST tracking.verify (M2M). The single call an IA makes after
 * installing the snippet to answer "is the tracking actually working?".
 */
export class TrackingVerifyResponseDto {
  @ApiProperty()
  workspace_id: string;

  @ApiProperty({ description: 'False when the workspace does not exist.' })
  workspace_exists: boolean;

  @ApiProperty({
    type: TrackingVerifyIngestion,
    description:
      'Real HTTP /api/track ingestion round-trip result (the honest probe).',
  })
  ingestion: TrackingVerifyIngestion;

  @ApiProperty({
    type: TrackingVerifySnippet,
    nullable: true,
    description: 'Snippet audit. null/absent when no site_url was supplied.',
  })
  snippet: TrackingVerifySnippet | null;

  @ApiProperty({
    type: TrackingVerifyRealTracking,
    description: 'Real tracking liveness (untouched by the synthetic probe).',
  })
  real_tracking: TrackingVerifyRealTracking;

  @ApiProperty({
    enum: [
      'ok',
      'ingestion_failed',
      'dropped_workspace_inactive',
      'dropped_domain_not_allowed',
      'snippet_missing',
      'snippet_misconfigured',
      'workspace_not_found',
    ],
    description: 'Single-word verdict an IA can branch on.',
  })
  verdict: TrackingVerifyVerdict;
}
